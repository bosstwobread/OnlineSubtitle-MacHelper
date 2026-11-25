(() => {
  "use strict";

  const youtubeOrigin = "https://www.youtube.com";
  if (location.origin !== youtubeOrigin || window.top !== window) return;

  const maximumCues = 10_000;
  const maximumCueBytes = 1_000;
  const maximumTranslationBytes = 2_000;
  const maximumVideoSeconds = 24 * 60 * 60;
  const captionsTimeout = 20_000;
  const translationTimeout = 90_000;
  const playerCheckInterval = 400;
  const playbackPrioritySeconds = 24;
  const captionRequestEvent = "online-subtitle-request-captions";
  const captionResultEvent = "online-subtitle-captions";
  const overlayAttribute = "data-online-subtitle-visible";
  const mediaEvents = ["timeupdate", "seeking", "seeked", "play", "pause", "loadedmetadata", "emptied", "ended"];
  const encoder = new TextEncoder();
  const statuses = {
    captionsUnavailable: "Captions unavailable for this video.",
    translationUnavailable: "Chinese translation unavailable.",
    macHelperUnavailable: "OnlineSubtitle could not connect to MacHelper.",
    modelUnavailable: "Start Ollama with a local model."
  };

  let session;
  let polling;
  let navigating = false;
  let navigateDeadline = 0;

  function watchVideoId() {
    if (location.origin !== youtubeOrigin || location.pathname !== "/watch") return null;
    const videoId = new URLSearchParams(location.search).get("v");
    return /^[A-Za-z0-9_-]{11}$/.test(videoId ?? "") ? videoId : null;
  }

  function isCurrent(state) {
    return session === state && state.player.isConnected && state.video.isConnected &&
      state.player.contains(state.video) && state.videoId === watchVideoId();
  }

  function showingAd(player) {
    return player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting");
  }

  function isActive(state) {
    return isCurrent(state) && !document.hidden && !showingAd(state.player);
  }

  function captionText(value, maximumBytes) {
    if (typeof value !== "string" || value.length > maximumBytes || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)) return "";
    const text = value.replace(/\s+/gu, " ").trim();
    return encoder.encode(text).length <= maximumBytes ? text : "";
  }

  function normalizeCues(raw) {
    if (!Array.isArray(raw) || raw.length > maximumCues) return [];
    const cues = [];
    for (const item of raw) {
      if (!item || !Number.isFinite(item.start) || !Number.isFinite(item.end) ||
          item.start < 0 || item.end <= item.start || item.end > maximumVideoSeconds) continue;
      const text = captionText(item.text, maximumCueBytes);
      if (text) cues.push({ start: item.start, end: item.end, text, translation: "" });
    }
    cues.sort((a, b) => a.start - b.start || a.end - b.end);
    let latestEnd = 0;
    for (const cue of cues) {
      latestEnd = Math.max(latestEnd, cue.end);
      cue.latestEnd = latestEnd;
    }
    return cues;
  }

  function nextCueIndex(cues, time) {
    let lower = 0;
    let upper = cues.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (cues[middle].start <= time) lower = middle + 1;
      else upper = middle;
    }
    return lower;
  }

  function activeCueIndex(cues, time, next = nextCueIndex(cues, time)) {
    for (let index = next - 1; index >= 0 && cues[index].latestEnd > time; index--) {
      if (cues[index].end > time) return index;
    }
    return -1;
  }

  function makeOverlay(player) {
    const root = document.createElement("div");
    root.className = "online-subtitle-overlay";
    const stack = document.createElement("div");
    stack.className = "online-subtitle-lines";
    stack.hidden = true;
    const original = document.createElement("div");
    original.className = "online-subtitle-line online-subtitle-original";
    original.dir = "auto";
    const translated = document.createElement("div");
    translated.className = "online-subtitle-line online-subtitle-translated";
    translated.lang = "zh-Hans";
    translated.dir = "auto";
    translated.hidden = true;
    const status = document.createElement("div");
    status.className = "online-subtitle-status";
    status.dir = "auto";
    status.setAttribute("role", "status");
    status.hidden = true;
    stack.append(original, translated);
    root.append(stack, status);
    player.append(root);
    return { root, stack, original, translated, status };
  }

  function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }

  function render(state) {
    const { player, video, overlay } = state;
    const active = isActive(state);
    const status = active && state.status ? chrome.i18n?.getMessage(state.status) || statuses[state.status] : "";
    setText(overlay.status, status);
    overlay.status.hidden = !status;
    const time = video.currentTime;
    const index = active && !video.seeking && !video.ended && Number.isFinite(time) && time >= 0
      ? activeCueIndex(state.cues, time) : -1;
    const cue = state.cues[index];
    setText(overlay.original, cue?.text ?? "");
    setText(overlay.translated, cue?.translation ?? "");
    overlay.stack.hidden = !cue;
    overlay.translated.hidden = !cue?.translation;
    player.toggleAttribute(overlayAttribute, Boolean(cue));
  }

  function cancelBatch(state) {
    const batch = state.batch;
    if (!batch) return;
    state.batch = undefined;
    clearTimeout(batch.timeout);
    batch.port?.disconnect();
  }

  function nextTranslationBatch(state) {
    const limit = state.translatedCount === 0 ? 3 : 8;
    const indexes = new Set();
    const { cues, video } = state;
    const time = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const next = nextCueIndex(cues, time);
    const current = activeCueIndex(cues, time, next);
    if (current >= 0 && !cues[current].translation) indexes.add(current);
    for (let index = next; index < cues.length && indexes.size < limit && cues[index].start <= time + playbackPrioritySeconds; index++) {
      if (!cues[index].translation) indexes.add(index);
    }
    for (let index = state.firstUntranslated; index < cues.length && indexes.size < limit; index++) {
      if (!cues[index].translation) indexes.add(index);
    }
    return [...indexes].sort((a, b) => a - b);
  }

  function validTranslations(response, indexes) {
    if (response?.ok !== true || !Array.isArray(response.translations) || response.translations.length !== indexes.length) return null;
    const remaining = new Set(indexes.map(index => index + 1));
    const translated = new Map();
    for (const entry of response.translations) {
      const text = captionText(entry?.text, maximumTranslationBytes);
      if (!text || !remaining.delete(entry?.id)) return null;
      translated.set(entry.id - 1, text);
    }
    return translated;
  }

  function finishBatch(state, batch, response) {
    if (state.batch !== batch) return;
    cancelBatch(state);
    if (!isActive(state)) return;

    const translations = validTranslations(response, batch.indexes);
    if (translations) {
      for (const [index, text] of translations) state.cues[index].translation = text;
      state.translatedCount += translations.size;
      while (state.cues[state.firstUntranslated]?.translation) state.firstUntranslated++;
      render(state);
      queueMicrotask(() => translateNext(state));
      return;
    }

    if (response?.ok === false && response.error === "busy" && !state.retriedBusy) {
      state.retriedBusy = true;
      state.retryTimer = setTimeout(() => {
        state.retryTimer = undefined;
        translateNext(state);
      }, 800);
      return;
    }
    state.status = response?.error === "unavailable" ? "macHelperUnavailable" :
      response?.error === "model" ? "modelUnavailable" : "translationUnavailable";
    render(state);
  }

  function translateNext(state) {
    if (!isActive(state) || state.video.seeking || state.batch || state.retryTimer || state.status ||
        !state.cues.length || state.translatedCount === state.cues.length) return;
    const indexes = nextTranslationBatch(state);
    const batch = { indexes, port: undefined, timeout: undefined };
    state.batch = batch;
    try {
      const port = chrome.runtime.connect({ name: "online-subtitle-translate" });
      batch.port = port;
      port.onMessage.addListener(response => finishBatch(state, batch, response));
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        finishBatch(state, batch, { ok: false, error: "unavailable" });
      });
      batch.timeout = setTimeout(() => finishBatch(state, batch, { ok: false, error: "translation" }), translationTimeout);
      port.postMessage({ type: "translate", cues: indexes.map(index => ({ id: index + 1, text: state.cues[index].text })) });
    } catch {
      finishBatch(state, batch, { ok: false, error: "unavailable" });
    }
  }

  function updatePlayback(state) {
    render(state);
    if (!isActive(state)) cancelBatch(state);
    else translateNext(state);
  }

  function requestCaptions(state) {
    if (!isCurrent(state) || document.hidden || state.requestId || state.cues.length || state.status) return;
    state.requestId = crypto.randomUUID();
    state.captionTimer = setTimeout(() => {
      if (!isCurrent(state)) return;
      state.requestId = undefined;
      state.status = "captionsUnavailable";
      render(state);
    }, captionsTimeout);
    document.dispatchEvent(new CustomEvent(captionRequestEvent, { detail: { id: state.requestId, videoId: state.videoId } }));
  }

  function receiveCaptions(event) {
    const state = session;
    const detail = event.detail;
    if (!state || !detail || !state.requestId || detail.id !== state.requestId ||
        detail.videoId !== state.videoId || !isCurrent(state)) return;
    clearTimeout(state.captionTimer);
    state.requestId = undefined;
    state.cues = detail.error ? [] : normalizeCues(detail.cues);
    if (!state.cues.length) state.status = "captionsUnavailable";
    if (typeof detail.sourceLanguage === "string" && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/.test(detail.sourceLanguage)) {
      state.overlay.original.lang = detail.sourceLanguage;
    }
    updatePlayback(state);
  }

  function startSession(videoId, player, video) {
    const state = {
      videoId, player, video, overlay: makeOverlay(player), cues: [], translatedCount: 0, firstUntranslated: 0,
      onMediaEvent(event) {
        if (event.type === "seeked" && state.batch && state.batch.indexes.every(index =>
          Math.abs(state.cues[index].start - video.currentTime) > playbackPrioritySeconds)) cancelBatch(state);
        updatePlayback(state);
      }
    };
    session = state;
    for (const name of mediaEvents) video.addEventListener(name, state.onMediaEvent);
    state.observer = new MutationObserver(() => {
      updatePlayback(state);
      requestCaptions(state);
    });
    state.observer.observe(player, { attributes: true, attributeFilter: ["class"] });
    requestCaptions(state);
  }

  function stopSession() {
    if (!session) return;
    const state = session;
    session = undefined;
    clearTimeout(state.captionTimer);
    clearTimeout(state.retryTimer);
    cancelBatch(state);
    state.observer.disconnect();
    for (const name of mediaEvents) state.video.removeEventListener(name, state.onMediaEvent);
    state.player.removeAttribute(overlayAttribute);
    state.overlay.root.remove();
  }

  function refresh() {
    if (navigating && Date.now() < navigateDeadline) return;
    navigating = false;
    if (document.hidden) {
      if (session) updatePlayback(session);
      return;
    }
    const videoId = watchVideoId();
    const player = videoId ? document.getElementById("movie_player") : null;
    const video = player?.querySelector("video.html5-main-video") ?? player?.querySelector("video");
    if (session && (session.videoId !== videoId || session.player !== player || session.video !== video)) stopSession();
    if (!player || !video) return;
    if (!session) startSession(videoId, player, video);
    else {
      updatePlayback(session);
      requestCaptions(session);
    }
  }

  function startPolling() {
    if (polling !== undefined) return;
    polling = setInterval(refresh, playerCheckInterval);
    refresh();
  }

  document.addEventListener(captionResultEvent, receiveCaptions);
  document.addEventListener("yt-navigate-start", () => {
    navigating = true;
    navigateDeadline = Date.now() + 5_000;
    stopSession();
  });
  document.addEventListener("yt-navigate-finish", () => {
    navigating = false;
    refresh();
  });
  document.addEventListener("visibilitychange", refresh);
  document.addEventListener("fullscreenchange", refresh);
  window.addEventListener("popstate", refresh);
  window.addEventListener("pageshow", startPolling);
  window.addEventListener("pagehide", () => {
    clearInterval(polling);
    polling = undefined;
    stopSession();
  });
  startPolling();
})();
