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
  const settingsTimeout = 5_000;
  const settingsRefreshInterval = 8_000;
  const wordLookupTimeout = 30_000;
  const defaultLanguage = "zh-CN";
  const targetLanguages = new Set(["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "pt", "it"]);
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
    translationUnavailable: "Subtitle translation unavailable.",
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

  function normalizeCues(raw, language) {
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
      cues: indexCues(globalThis.onlineSubtitleGroupCaptionSentences(cues.sort(byTime), maximumCues, language)),
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

  function message(key) {
    return chrome.i18n?.getMessage(key) || statuses[key] || "";
  }

  function makeOverlay(state) {
    const { player } = state;
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
    translated.lang = state.configuration?.targetLanguage ?? defaultLanguage;
    translated.dir = "auto";
    const status = document.createElement("div");
    status.className = "online-subtitle-status";
    status.dir = "auto";
    status.setAttribute("role", "status");
    status.hidden = true;
    stack.append(original, translated);
    root.append(stack, status);
    player.append(root);
    const interactions = globalThis.onlineSubtitleCreateInteractions({
      player, root, stack, original, message,
      onWord: word => startLookup(state, word),
      onDismiss: () => {
        dismissLookup(state);
        translateNext(state);
      }
    });
    return { root, stack, original, translated, status, interactions };
  }

  function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }

  function render(state) {
    const { player, video, overlay } = state;
    const active = isCurrent(state) && state.lastAdTime === undefined && !showingAd(player);
    const status = active && state.status ? message(state.status) : "";
    setText(overlay.status, status);
    overlay.status.hidden = !status;
    const time = video.currentTime;
    const canShow = active && !video.seeking && !video.ended && Number.isFinite(time) && time >= 0;
    const index = canShow ? activeCueIndex(state.cues, time) : -1;
    const cue = state.cues[index];
    const bilingual = cue?.bilingual;
    if (state.lookup && (!canShow || state.lookup.cue !== cue)) dismissLookup(state);
    state.presentedCue = bilingual ? cue : undefined;
    overlay.interactions.renderSource(bilingual?.original ?? "", state.sourceLanguage);
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
    state.batch = undefined;
    closeRequest(batch);
  }

  function closeRequest(request) {
    if (!request) return;
    clearTimeout(request.timeout);
    const port = request.port;
    request.port = undefined;
    port?.disconnect();
  }

  function sendRequest(request, payload, timeout, receive) {
    function finish(reply) {
      if (!request.port) return;
      closeRequest(request);
      receive(reply);
    }
    try {
      const port = chrome.runtime.connect({ name: "online-subtitle-translate" });
      request.port = port;
      port.onMessage.addListener(finish);
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        finish({ ok: false, error: "unavailable" });
      });
      request.timeout = setTimeout(() => finish({ ok: false, error: "translation" }), timeout);
      port.postMessage(payload);
    } catch {
      closeRequest(request);
      receive({ ok: false, error: "unavailable" });
    }
  }

  function readConfiguration(reply) {
    if (!targetLanguages.has(reply?.targetLanguage) || typeof reply.revision !== "string" ||
        !/^[a-f0-9]{64}$/.test(reply.revision)) return null;
    return { targetLanguage: reply.targetLanguage, revision: reply.revision };
  }

  function applyConfiguration(state, configuration) {
    if (state.configuration?.revision === configuration.revision &&
        state.configuration?.targetLanguage === configuration.targetLanguage) return;
    state.configuration = configuration;
    state.overlay.translated.lang = configuration.targetLanguage;
    cancelBatch(state);
    dismissLookup(state);
    clearTimeout(state.retryTimer);
    state.retryTimer = undefined;
    state.retriedBusy = false;
    if (state.status !== "captionsUnavailable") state.status = undefined;
    if (state.translatedCount) {
      for (const cue of state.cues) delete cue.bilingual;
      state.translatedCount = 0;
      state.firstUntranslated = 0;
    }
  }

  function requestSettings(state) {
    state.refreshSettings = false;
    state.nextSettingsCheck = Date.now() + settingsRefreshInterval;
    const request = {};
    state.settingsRequest = request;
    render(state);
    sendRequest(request, { type: "getSettings" }, settingsTimeout, reply => {
      if (state.settingsRequest !== request || !isCurrent(state)) return;
      state.settingsRequest = undefined;
      const configuration = reply?.ok === true ? readConfiguration(reply) : null;
      if (configuration) {
        applyConfiguration(state, configuration);
        if (state.status === "macHelperUnavailable") state.status = undefined;
      } else if (reply?.error === "invalid" && !state.configuration) {
        // The 0.3.x companion bridge does not implement settings.
        state.legacySettings = true;
        applyConfiguration(state, { targetLanguage: defaultLanguage, revision: null });
      } else if (!state.configuration) {
        state.status = "macHelperUnavailable";
      }
      render(state);
      translateNext(state);
    });
  }

  function dismissLookup(state) {
    const lookup = state.lookup;
    if (!lookup) return;
    state.lookup = undefined;
    clearTimeout(lookup.retry);
    closeRequest(lookup.request);
    state.overlay?.interactions.closeLookup();
  }

  function requestLookup(state, lookup) {
    const request = {};
    lookup.request = request;
    sendRequest(request, { type: "explainWord", word: lookup.word, sentence: lookup.sentence }, wordLookupTimeout, reply => {
      if (state.lookup !== lookup || !isCurrent(state)) return;
      lookup.request = undefined;
      if (reply?.error === "busy" && !lookup.retried) {
        lookup.retried = true;
        lookup.retry = setTimeout(() => {
          lookup.retry = undefined;
          if (state.lookup === lookup && isCurrent(state)) requestLookup(state, lookup);
        }, 250);
        return;
      }
      const configuration = reply?.ok === true ? readConfiguration(reply) : null;
      if (configuration && (configuration.revision !== state.configuration?.revision ||
          configuration.targetLanguage !== state.configuration?.targetLanguage)) {
        applyConfiguration(state, configuration);
        render(state);
      } else {
        const meaning = captionText(reply?.meaning, maximumTranslationBytes);
        if (configuration && meaning) {
          state.overlay.interactions.completeLookup({ meaning, targetLanguage: configuration.targetLanguage });
        } else {
          state.overlay.interactions.failLookup();
        }
      }
      translateNext(state);
    });
  }

  function startLookup(state, word) {
    const cue = state.presentedCue;
    const sentence = cue?.bilingual?.original;
    if (!isCurrent(state) || state.video.seeking || state.video.ended || showingAd(state.player) ||
        !captionText(sentence, maximumCueBytes) || !captionText(word, 256) || !sentence.includes(word)) return;
    dismissLookup(state);
    cancelBatch(state);
    if (state.settingsRequest) {
      closeRequest(state.settingsRequest);
      state.settingsRequest = undefined;
      state.refreshSettings = true;
    }
    const lookup = { cue, word, sentence };
    state.lookup = lookup;
    state.video.pause();
    state.overlay.interactions.showLookup(word);
    requestLookup(state, lookup);
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
    if (("revision" in response || "targetLanguage" in response) && !readConfiguration(response)) return null;
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
      const configuration = readConfiguration(response);
      if (configuration) applyConfiguration(state, configuration);
      let added = 0;
      for (const [index, { text, source }] of translations) {
        const cue = state.cues[index];
        if (!cue.bilingual) added++;
        cue.bilingual = { original: source || cue.text, translation: text };
      }
      state.translatedCount += added;
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
    translateNext(state);
  }

  function translateNext(state) {
    if (!isCurrent(state) || state.batch || state.settingsRequest || state.lookup?.request || state.lookup?.retry) return;
    if (!state.legacySettings && (state.refreshSettings || Date.now() >= state.nextSettingsCheck)) {
      requestSettings(state);
      return;
    }
    if (!state.configuration || (state.video.seeking && !showingAd(state.player)) || state.retryTimer || state.status ||
        !state.cues.length || state.translatedCount === state.cues.length) return;
    const indexes = nextTranslationBatch(state);
    const batch = { indexes, kind: state.translationKind };
    state.batch = batch;
    const cues = indexes.map(index => ({ id: index + 1, text: state.cues[index].text }));
    sendRequest(batch, { type: batch.kind, cues }, translationTimeout, reply => finishBatch(state, batch, reply));
  }

  function updatePlayback(state, mediaEvent) {
    if (mediaEvent === "play" || mediaEvent === "seeking") dismissLookup(state);
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
    const sourceLanguage = typeof detail.sourceLanguage === "string" &&
      /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/.test(detail.sourceLanguage) ? detail.sourceLanguage : "";
    const { cues, soundOnly } = normalizeCues(detail.cues, sourceLanguage);
    if (!cues.length && !soundOnly.length) {
      captionsUnavailable(state);
      return;
    }
    state.cues = cues;
    state.soundOnly = soundOnly;
    state.sourceLanguage = sourceLanguage;
    state.overlay.original.lang = sourceLanguage;
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
    state.overlay = makeOverlay(state);
    state.refreshSettings = true;
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
    dismissLookup(state);
    closeRequest(state.settingsRequest);
    state.settingsRequest = undefined;
    clearTimeout(state.retryTimer);
    state.retryTimer = undefined;
    cancelBatch(state);
    state.observer.disconnect();
    for (const name of mediaEvents) state.video.removeEventListener(name, state.onMediaEvent);
    state.player.removeAttribute(overlayAttribute);
    state.overlay.interactions.destroy();
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
  window.addEventListener("focus", () => {
    if (!session?.overlay) { refresh(); return; }
    session.refreshSettings = true;
    translateNext(session);
  });
  window.addEventListener("popstate", refresh);
  window.addEventListener("pageshow", startPolling);
  window.addEventListener("pagehide", () => {
    clearInterval(polling);
    polling = undefined;
    stopWatch();
  });
  startPolling();
})();
