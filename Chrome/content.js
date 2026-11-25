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
  const statusTimeout = 5_000;
  const firstStatusRetryDelay = 500;
  const maximumStatusRetryDelay = 5_000;
  const playbackPrioritySeconds = 24;
  const captionRequestEvent = "online-subtitle-request-captions";
  const captionCancelEvent = "online-subtitle-cancel-captions";
  const captionResultEvent = "online-subtitle-captions";
  const overlayAttribute = "data-online-subtitle-visible";
  const mediaEvents = ["timeupdate", "seeking", "seeked", "play", "playing", "pause", "loadedmetadata", "emptied", "ended"];
  const encoder = new TextEncoder();
  const statuses = {
    captionsUnavailable: "Captions unavailable for this video.",
    translationUnavailable: "Chinese translation unavailable.",
    macHelperUnavailable: "OnlineSubtitle could not connect to MacHelper.",
    modelUnavailable: "Check AI Connection in MacHelper."
  };

  let watch;
  let session;
  let polling;
  let navigating = false;
  let navigateDeadline = 0;

  function watchVideoId() {
    if (location.origin !== youtubeOrigin || location.pathname !== "/watch") return null;
    const videoIds = new URLSearchParams(location.search).getAll("v");
    return videoIds.length === 1 && /^[A-Za-z0-9_-]{11}$/.test(videoIds[0]) ? videoIds[0] : null;
  }

  function watchStartTime() {
    const params = new URLSearchParams(location.search);
    const timestamp = params.get("t") ?? params.get("start") ?? "";
    const duration = /^\d{1,5}$/.test(timestamp) ? `${timestamp}s` : timestamp;
    const [, hours = 0, minutes = 0, rest = 0] =
      /^(?:(\d{1,2})h)?(?:(\d{1,5})m)?(?:(\d{1,5})s)?$/.exec(duration) ?? [];
    const seconds = Number(hours) * 3600 + Number(minutes) * 60 + Number(rest);
    return seconds <= maximumVideoSeconds ? seconds : 0;
  }

  function isCurrentWatch(context) {
    return watch === context && !document.hidden && context.player.isConnected && context.video.isConnected &&
      context.player.contains(context.video) && context.videoId === watchVideoId();
  }

  function isCurrent(state) {
    return session === state && state.overlay !== undefined && isCurrentWatch(state.watch);
  }

  function showingAd(player) {
    return player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting");
  }

  function captionText(value, maximumBytes) {
    if (typeof value !== "string" || value.length > maximumBytes || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)) return "";
    const text = value.replace(/\s+/gu, " ").trim();
    return encoder.encode(text).length <= maximumBytes ? text : "";
  }

  function normalizeCues(raw) {
    if (!Array.isArray(raw) || raw.length > maximumCues) return { cues: [], soundOnly: [] };
    const cues = [];
    const soundOnly = [];
    for (const item of raw) {
      if (!item || !Number.isFinite(item.start) || !Number.isFinite(item.end) ||
          item.start < 0 || item.end <= item.start || item.end > maximumVideoSeconds) continue;
      const source = captionText(item.text, maximumCueBytes);
      if (!source) continue;
      const text = globalThis.onlineSubtitleRemoveSoundLabels(source);
      if (text) cues.push({ start: item.start, end: item.end, text });
      else soundOnly.push({ start: item.start, end: item.end });
    }
    const byTime = (a, b) => a.start - b.start || a.end - b.end;
    return {
      cues: indexCues(globalThis.onlineSubtitleGroupCaptionSentences(cues.sort(byTime), maximumCues)),
      soundOnly: indexCues(soundOnly.sort(byTime))
    };
  }

  function indexCues(cues) {
    let latestEnd = 0;
    return cues.map(cue => {
      latestEnd = Math.max(latestEnd, cue.end);
      return { ...cue, latestEnd };
    });
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
    const active = isCurrent(state) && state.lastAdTime === undefined && !showingAd(player);
    const status = active && state.status ? chrome.i18n?.getMessage(state.status) || statuses[state.status] : "";
    setText(overlay.status, status);
    overlay.status.hidden = !status;
    const time = video.currentTime;
    const canShow = active && !video.seeking && !video.ended && Number.isFinite(time) && time >= 0;
    const index = canShow ? activeCueIndex(state.cues, time) : -1;
    const cue = state.cues[index];
    const bilingual = cue?.bilingual;
    setText(overlay.original, bilingual?.original ?? "");
    setText(overlay.translated, bilingual?.translation ?? "");
    overlay.stack.hidden = !bilingual;
    // Keep native CC enabled in YouTube. Mask it only while this cue is
    // waiting for both languages or being replaced by the bilingual overlay.
    const awaitingTranslation = cue && !bilingual && !state.status;
    player.toggleAttribute(overlayAttribute,
      Boolean(bilingual || awaitingTranslation) || (canShow && !cue && activeCueIndex(state.soundOnly, time) !== -1));
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
    const { cues, contentTime: time } = state;
    const next = nextCueIndex(cues, time);
    const current = activeCueIndex(cues, time, next);
    if (current >= 0 && !cues[current].bilingual) indexes.add(current);
    for (let index = next; index < cues.length && indexes.size < limit && cues[index].start <= time + playbackPrioritySeconds; index++) {
      if (!cues[index].bilingual) indexes.add(index);
    }
    for (let index = state.firstUntranslated; index < cues.length && indexes.size < limit; index++) {
      if (!cues[index].bilingual) indexes.add(index);
    }
    return [...indexes].sort((a, b) => a - b);
  }

  function validTranslations(response, { indexes, kind }) {
    if (response?.ok !== true || !Array.isArray(response.translations) || response.translations.length !== indexes.length) return null;
    const remaining = new Set(indexes.map(index => index + 1));
    const translated = new Map();
    for (const entry of response.translations) {
      const text = globalThis.onlineSubtitleRemoveSoundLabels(captionText(entry?.text, maximumTranslationBytes));
      if (!text || !remaining.delete(entry?.id)) return null;
      const source = kind === "translateSentences"
        ? globalThis.onlineSubtitleRemoveSoundLabels(captionText(entry.source, maximumCueBytes)) : "";
      translated.set(entry.id - 1, { text, source });
    }
    return translated;
  }

  function finishBatch(state, batch, response) {
    if (state.batch !== batch) return;
    cancelBatch(state);
    if (!isCurrent(state)) return;

    const translations = validTranslations(response, batch);
    if (translations) {
      for (const [index, { text, source }] of translations) {
        const cue = state.cues[index];
        cue.bilingual = { original: source || cue.text, translation: text };
      }
      state.translatedCount += translations.size;
      while (state.cues[state.firstUntranslated]?.bilingual) state.firstUntranslated++;
      render(state);
      queueMicrotask(() => translateNext(state));
      return;
    }

    // Older native hosts reject the new request before running the model.
    if (response?.ok === false && response.error === "invalid" && batch.kind === "translateSentences") {
      state.translationKind = "translate";
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
    if (!isCurrent(state) || (state.video.seeking && !showingAd(state.player)) || state.batch || state.retryTimer || state.status ||
        !state.cues.length || state.translatedCount === state.cues.length) return;
    const indexes = nextTranslationBatch(state);
    const batch = { indexes, kind: state.translationKind, port: undefined, timeout: undefined };
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
      port.postMessage({ type: batch.kind, cues: indexes.map(index => ({ id: index + 1, text: state.cues[index].text })) });
    } catch {
      finishBatch(state, batch, { ok: false, error: "unavailable" });
    }
  }

  function updatePlayback(state, mediaEvent) {
    const { player, video } = state;
    const time = video.currentTime;
    if (showingAd(player)) {
      state.lastAdTime = time;
    } else if (!video.seeking && video.readyState >= video.HAVE_METADATA && Number.isFinite(time) && time >= 0) {
      // The ad class can disappear before the shared video element leaves the ad's playhead.
      if (time !== state.lastAdTime || mediaEvent === "loadedmetadata" || mediaEvent === "playing") {
        const resumed = state.lastAdTime !== undefined;
        state.lastAdTime = undefined;
        state.contentTime = time;
        if ((resumed || mediaEvent === "seeked") && state.batch?.indexes.every(index =>
          Math.abs(state.cues[index].start - time) > playbackPrioritySeconds)) cancelBatch(state);
      }
    }
    render(state);
    translateNext(state);
  }

  function cancelCaptionRequest(state) {
    const id = state.requestId;
    state.requestId = undefined;
    clearTimeout(state.captionTimer);
    if (id) {
      document.dispatchEvent(new CustomEvent(captionCancelEvent, { detail: { id, videoId: state.videoId } }));
    }
  }

  function requestCaptions(state) {
    if (!isCurrent(state) || state.requestId || state.cues.length || state.soundOnly.length || state.status) return;
    const ad = showingAd(state.player);
    if (state.captionRetry === "afterAd") {
      if (ad) return;
      state.captionRetry = "used";
    }
    state.requestStartedInAd = ad;
    state.requestId = crypto.randomUUID();
    state.captionTimer = setTimeout(() => {
      if (!isCurrent(state)) return;
      cancelCaptionRequest(state);
      captionsUnavailable(state);
    }, captionsTimeout);
    document.dispatchEvent(new CustomEvent(captionRequestEvent, { detail: { id: state.requestId, videoId: state.videoId } }));
  }

  function captionsUnavailable(state) {
    if (state.captionRetry !== "used" && (state.requestStartedInAd || showingAd(state.player))) {
      state.captionRetry = "afterAd";
      requestCaptions(state);
      return;
    }
    state.status = "captionsUnavailable";
    render(state);
  }

  function receiveCaptions(event) {
    const state = session;
    const detail = event.detail;
    if (!state || !detail || !state.requestId || detail.id !== state.requestId ||
        detail.videoId !== state.videoId || !isCurrent(state)) return;
    clearTimeout(state.captionTimer);
    state.requestId = undefined;
    if (detail.error) {
      captionsUnavailable(state);
      return;
    }
    const { cues, soundOnly } = normalizeCues(detail.cues);
    if (!cues.length && !soundOnly.length) {
      captionsUnavailable(state);
      return;
    }
    state.cues = cues;
    state.soundOnly = soundOnly;
    if (typeof detail.sourceLanguage === "string" && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/.test(detail.sourceLanguage)) {
      state.sourceLanguage = detail.sourceLanguage;
      state.overlay.original.lang = state.sourceLanguage;
    }
    updatePlayback(state);
  }

  function startSession(context) {
    const { videoId, player, video } = context;
    const state = {
      watch: context, videoId, player, video, cues: [], soundOnly: [], translatedCount: 0, firstUntranslated: 0,
      contentTime: watchStartTime(), translationKind: "translateSentences",
      onMediaEvent(event) {
        if (isCurrent(state)) updatePlayback(state, event.type);
      }
    };
    session = state;
    return state;
  }

  function showSession(state) {
    if (state.overlay) return;
    const { player, video } = state;
    state.overlay = makeOverlay(player);
    if (state.sourceLanguage) state.overlay.original.lang = state.sourceLanguage;
    for (const name of mediaEvents) video.addEventListener(name, state.onMediaEvent);
    state.observer = new MutationObserver(() => {
      if (!isCurrent(state)) return;
      updatePlayback(state);
      requestCaptions(state);
    });
    state.observer.observe(player, { attributes: true, attributeFilter: ["class"] });
    updatePlayback(state);
    requestCaptions(state);
  }

  function hideSession() {
    const state = session;
    if (!state?.overlay) return;
    cancelCaptionRequest(state);
    clearTimeout(state.retryTimer);
    state.retryTimer = undefined;
    cancelBatch(state);
    state.observer.disconnect();
    for (const name of mediaEvents) state.video.removeEventListener(name, state.onMediaEvent);
    state.player.removeAttribute(overlayAttribute);
    state.overlay.root.remove();
    state.overlay = undefined;
  }

  function stopSession() {
    hideSession();
    session = undefined;
  }

  function reconnectStatus(context) {
    if (!isCurrentWatch(context) || context.retryTimer !== undefined) return;
    context.retryTimer = setTimeout(() => {
      context.retryTimer = undefined;
      connectStatus(context);
    }, context.retryDelay);
    context.retryDelay = Math.min(context.retryDelay * 2, maximumStatusRetryDelay);
  }

  function closeStatus(context) {
    clearTimeout(context.statusTimer);
    const port = context.port;
    context.port = undefined;
    port?.disconnect();
  }

  function loseStatus(context) {
    if (watch !== context) return;
    stopSession();
    closeStatus(context);
    reconnectStatus(context);
  }

  function connectStatus(context) {
    if (!isCurrentWatch(context) || context.port) return;
    try {
      const port = chrome.runtime.connect({ name: "online-subtitle-status" });
      context.port = port;
      port.onMessage.addListener(message => {
        if (context.port !== port || !isCurrentWatch(context)) return;
        if (message?.type !== "status" || typeof message.enabled !== "boolean" || Object.keys(message).length !== 2) {
          loseStatus(context);
          return;
        }
        clearTimeout(context.statusTimer);
        if (message.enabled) {
          context.retryDelay = firstStatusRetryDelay;
          showSession(session ?? startSession(context));
        } else {
          stopSession();
        }
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (context.port !== port) return;
        context.port = undefined;
        if (watch === context) loseStatus(context);
      });
      context.statusTimer = setTimeout(() => {
        if (context.port === port) loseStatus(context);
      }, statusTimeout);
      port.postMessage({ type: "watchStatus" });
    } catch {
      loseStatus(context);
    }
  }

  function stopWatch() {
    if (!watch) return;
    suspendWatch();
    watch = undefined;
    session = undefined;
  }

  function suspendWatch() {
    if (!watch) return;
    hideSession();
    clearTimeout(watch.retryTimer);
    watch.retryTimer = undefined;
    closeStatus(watch);
  }

  function refresh() {
    if (polling === undefined) return;
    if (navigating && Date.now() < navigateDeadline) return;
    navigating = false;
    if (document.hidden) {
      suspendWatch();
      return;
    }
    const videoId = watchVideoId();
    const player = videoId ? document.getElementById("movie_player") : null;
    const video = player?.querySelector("video.html5-main-video") ?? player?.querySelector("video");
    if (watch && (watch.player !== player || watch.video !== video || !isCurrentWatch(watch))) stopWatch();
    if (!player || !video) return;
    if (!watch) watch = { videoId, player, video, retryDelay: firstStatusRetryDelay };
    if (!watch.port && watch.retryTimer === undefined) connectStatus(watch);
    if (session?.overlay) {
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
    stopWatch();
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
    stopWatch();
  });
  startPolling();
})();
