(() => {
  "use strict";

  const origin = "https://www.netflix.com";
  if (location.origin !== origin || window.top !== window) return;

  const replaced = "data-online-subtitle-netflix-replaced";
  const captionSelector = ".player-timedtext";
  const pollInterval = 300;
  const lookaheadSeconds = 32;
  const trackRequestEvent = "online-subtitle:netflix-request";
  const trackResultEvent = "online-subtitle:netflix-track";
  const retryDelays = [500, 1_000, 2_000];
  const targetLanguages = new Set(["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "pt", "it"]);
  const mediaEvents = ["seeking", "seeked", "emptied", "loadedmetadata", "ended"];
  const encoder = new TextEncoder();
  let watch;
  let polling;

  function watchId() {
    return /^\/watch\/([0-9]{1,20})$/.exec(location.pathname)?.[1];
  }

  function isCurrent(state) {
    return watch === state && !document.hidden && watchId() === state.id && state.player.isConnected &&
      state.video.isConnected && state.player.contains(state.video) && state.player.getAttribute("data-videoid") === state.id;
  }

  function cleanText(value, maximum) {
    if (typeof value !== "string" || value.length > maximum || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u.test(value)) return "";
    const text = value.replace(/\s+/gu, " ").trim();
    return encoder.encode(text).length <= maximum ? text : "";
  }

  function captionText(value) {
    return globalThis.onlineSubtitleRemoveSoundLabels(cleanText(value, 1_000));
  }

  // Netflix may add a line break at a speaker dash or a directional mark in its DOM.
  function comparableText(text) {
    return text.normalize("NFC").replace(/[\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "")
      .replace(/\s*([-–—])\s*/gu, "$1").trim();
  }

  function cacheKey(text, language) {
    return `${language}\0${comparableText(text)}`;
  }

  function readCue(node) {
    if (!node?.isConnected || node.hidden || !node.getClientRects().length) return;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return;
    const text = captionText(node.innerText ?? node.textContent);
    if (!text) return;
    const lang = node.getAttribute("lang");
    const language = lang && lang.length <= 40 && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(lang) ? lang : "";
    return { node, text, language, key: cacheKey(text, language) };
  }

  function sameCue(first, second) {
    return first?.node === second?.node && first?.key === second?.key;
  }

  function readConfiguration(reply) {
    if (reply?.ok !== true || !targetLanguages.has(reply.targetLanguage) ||
        typeof reply.revision !== "string" || !/^[a-f0-9]{64}$/u.test(reply.revision)) return;
    return { targetLanguage: reply.targetLanguage, revision: reply.revision };
  }

  function sameConfiguration(first, second) {
    return first?.revision === second?.revision && first?.targetLanguage === second?.targetLanguage;
  }

  function closeRequest(request) {
    if (!request) return;
    clearTimeout(request.timer);
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
      request.timer = setTimeout(() => finish({ ok: false, error: "unavailable" }), timeout);
      port.postMessage(payload);
    } catch {
      closeRequest(request);
      receive({ ok: false, error: "unavailable" });
    }
  }

  function dismissLookup(state) {
    const lookup = state.lookup;
    state.lookup = undefined;
    if (lookup) {
      closeRequest(lookup.request);
      state.overlay.interactions.closeLookup();
    }
  }

  function replaceNativeCaption(state, node) {
    if (state.masked === node) return;
    state.masked?.removeAttribute(replaced);
    state.masked = node;
    node?.setAttribute(replaced, "");
  }

  function makeOverlay(state) {
    function element(className) {
      const node = document.createElement("div");
      node.className = className;
      return node;
    }
    const root = element("online-subtitle-overlay");
    const stack = element("online-subtitle-lines");
    const original = element("online-subtitle-line online-subtitle-original");
    const translated = element("online-subtitle-line online-subtitle-translated");
    original.dir = translated.dir = "auto";
    stack.hidden = true;
    stack.append(original, translated);
    root.append(stack);
    state.player.append(root);
    const interactions = globalThis.onlineSubtitleCreateInteractions({
      player: state.player, root, stack, original,
      message: key => chrome.i18n?.getMessage(key) ?? "",
      onWord: word => startLookup(state, word),
      onDismiss: () => { dismissLookup(state); update(state); }
    });
    return { root, stack, original, translated, interactions };
  }

  function render(state) {
    const { overlay, cue } = state;
    const translation = cue && state.settingsReady && state.cache.get(cue.key);
    overlay.interactions.renderSource(translation ? cue.text : "", cue?.language);
    overlay.original.lang = cue?.language || "";
    overlay.translated.lang = state.configuration?.targetLanguage || "";
    if (overlay.translated.textContent !== (translation || "")) overlay.translated.textContent = translation || "";
    overlay.stack.hidden = !translation;
    replaceNativeCaption(state, translation ? cue.node : undefined);
  }

  function cancelBatch(state) {
    closeRequest(state.batch);
    state.batch = undefined;
    state.busy = undefined;
  }

  function setCue(state, cue) {
    if (sameCue(state.cue, cue)) return;
    dismissLookup(state);
    state.cue = cue;
  }

  function sampleCue(state) {
    const { video } = state;
    if (video.seeking || video.ended || video.readyState < video.HAVE_METADATA) return;
    const cue = readCue(state.player.querySelector(captionSelector));
    if (sameCue(state.preSeekCue, cue)) return;
    state.preSeekCue = undefined;
    return cue;
  }

  function applyConfiguration(state, configuration) {
    if (!sameConfiguration(state.configuration, configuration)) {
      state.cache.clear();
      state.configuration = configuration;
      state.failed.clear();
      state.busy = undefined;
      dismissLookup(state);
    }
    state.settingsReady = true;
  }

  function requestSettings(state) {
    const request = {};
    state.settingsRequest = request;
    state.settingsAt = Date.now() + 8_000;
    sendRequest(request, { type: "getSettings" }, 5_000, reply => {
      if (state.settingsRequest !== request || !isCurrent(state)) return;
      state.settingsRequest = undefined;
      const configuration = readConfiguration(reply);
      if (configuration) applyConfiguration(state, configuration);
      else if (reply?.error === "invalid" && !state.configuration) {
        // Older Chrome bridges accept plain translations without reporting preferences.
        state.settingsAt = Infinity;
        applyConfiguration(state, { targetLanguage: "zh-CN", revision: null });
      }
      update(state);
    });
  }

  function validReplyConfiguration(reply) {
    if (!Object.hasOwn(reply, "targetLanguage") && !Object.hasOwn(reply, "revision")) return true;
    return !!readConfiguration(reply);
  }

  function readTrack(event) {
    const state = watch;
    if (!state?.overlay || !isCurrent(state) || typeof event.detail !== "string" ||
        event.detail.length > 2 * 1024 * 1024) return;
    let track;
    try { track = JSON.parse(event.detail); } catch { return; }
    if (track?.videoId !== state.id || !Array.isArray(track.cues) ||
        track.cues.length === 0 || track.cues.length > 4_000) return;
    const cues = [];
    let lastStart = -1;
    for (const item of track.cues) {
      if (!Number.isFinite(item?.start) || !Number.isFinite(item.end) || item.start < 0 ||
          item.start < lastStart || item.end <= item.start || item.end > 86_400) return;
      lastStart = item.start;
      const text = captionText(item.text);
      if (text) cues.push({ start: item.start, end: item.end, text, comparable: comparableText(text) });
    }
    if (!cues.length) return;
    const language = typeof track.language === "string" && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(track.language) ?
      track.language.toLowerCase() : "";
    state.tracks.unshift({ cues, language });
    if (state.tracks.length > 4) state.tracks.pop();
    update(state);
  }

  function upcomingCues(track, time, currentText) {
    let lower = 0;
    let upper = track.length;
    // The player updates the DOM and video clock on different frames.
    while (lower < upper) {
      const mid = (lower + upper) >>> 1;
      if (track[mid].start <= time + 0.25) lower = mid + 1;
      else upper = mid;
    }
    for (let i = lower - 1; i >= Math.max(0, lower - 8); i--) {
      if (track[i].end < time - 0.25 || track[i].comparable !== currentText) continue;
      const upcoming = [];
      for (let j = i + 1; j < track.length && track[j].start <= time + lookaheadSeconds && upcoming.length < 64; j++) {
        upcoming.push(track[j].text);
      }
      return upcoming;
    }
  }

  function nextBatch(state, cue) {
    const current = comparableText(cue.text);
    let ahead;
    for (const track of state.tracks) {
      if (cue.language && track.language && cue.language.toLowerCase().split("-")[0] !== track.language.split("-")[0]) continue;
      const upcoming = upcomingCues(track.cues, state.video.currentTime, current);
      if (!upcoming) continue;
      if (!ahead) ahead = upcoming;
      else {
        // Two available tracks can share one line. Only prepare their common prefix.
        let shared = 0;
        while (shared < ahead.length && shared < upcoming.length &&
            comparableText(ahead[shared]) === comparableText(upcoming[shared])) shared++;
        ahead.length = shared;
      }
    }
    const texts = [cue.text, ...(ahead ?? [])];
    const limit = state.cache.size ? 8 : 3;
    const rows = [];
    for (const text of new Set(texts)) {
      const key = cacheKey(text, cue.language);
      if (state.cache.has(key) || state.failed.has(key)) continue;
      rows.push({ key, text });
      if (rows.length === limit) break;
    }
    return rows;
  }

  function remember(map, key, value) {
    map.set(key, value);
    if (map.size > 256) map.delete(map.keys().next().value);
  }

  function requestTranslation(state, rows) {
    const first = rows[0].key;
    if (state.busy?.key === first && Date.now() < state.busy.retryAt) return;
    const request = { language: state.cue.language };
    state.batch = request;
    const cues = rows.map(({ text }, index) => ({ id: index + 1, text }));
    sendRequest(request, { type: "translate", cues }, 90_000, reply => {
      if (state.batch !== request || !isCurrent(state)) return;
      state.batch = undefined;
      if (reply?.error === "busy") {
        const count = state.busy?.key === first ? state.busy.count : 0;
        if (count < retryDelays.length) {
          state.busy = { key: first, count: count + 1, retryAt: Date.now() + retryDelays[count] };
          return;
        }
      }
      state.busy = undefined;
      const translations = reply?.translations;
      const valid = reply?.ok === true && validReplyConfiguration(reply) &&
        Array.isArray(translations) && translations.length === rows.length;
      const output = valid ? translations.map((row, index) => row?.id === index + 1 &&
        onlineSubtitleRemoveSoundLabels(cleanText(row.text, 2_000))) : [];
      if (output.length === rows.length && output.every(Boolean)) {
        const configuration = readConfiguration(reply);
        if (configuration) applyConfiguration(state, configuration);
        rows.forEach(({ key }, index) => remember(state.cache, key, output[index]));
      } else {
        for (const { key } of rows) remember(state.failed, key, true);
      }
      // The native caption may already have advanced while the AI was working.
      update(state);
    });
  }

  function startLookup(state, rawWord) {
    const { cue } = state;
    const word = cleanText(rawWord, 256);
    if (!isCurrent(state) || !state.settingsReady || !cue || !state.cache.has(cue.key) ||
        !sameCue(cue, sampleCue(state)) || !word || !cue.text.includes(word)) return;
    dismissLookup(state);
    cancelBatch(state);
    if (state.settingsRequest) {
      closeRequest(state.settingsRequest);
      state.settingsRequest = undefined;
      state.settingsAt = 0;
    }
    const lookup = { request: {} };
    state.lookup = lookup;
    state.video.pause();
    state.overlay.interactions.showLookup(word);
    sendRequest(lookup.request, { type: "explainWord", word, sentence: cue.text }, 30_000, reply => {
      if (state.lookup !== lookup || !isCurrent(state)) return;
      lookup.request = undefined;
      if (!sameCue(cue, sampleCue(state))) { update(state); return; }
      const configuration = readConfiguration(reply);
      const meaning = cleanText(reply?.meaning, 2_000);
      if (configuration && meaning && sameConfiguration(state.configuration, configuration)) {
        state.overlay.interactions.completeLookup({ meaning, targetLanguage: configuration.targetLanguage });
      } else {
        state.overlay.interactions.failLookup();
      }
    });
  }

  function observeCaption(state) {
    const node = state.player.querySelector(captionSelector);
    if (node === state.observed) return;
    state.observer.disconnect();
    state.observed = node;
    if (node) state.observer.observe(node, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ["class", "style", "hidden", "lang"]
    });
  }

  function update(state) {
    if (!state.overlay || !isCurrent(state)) return;
    observeCaption(state);
    setCue(state, sampleCue(state));
    render(state);
    const { cue } = state;
    if (state.batch && cue && cue.language !== state.batch.language) cancelBatch(state);
    if (state.settingsRequest || state.batch || state.lookup?.request) return;
    if (Date.now() >= state.settingsAt) requestSettings(state);
    else if (state.settingsReady && cue) {
      const rows = nextBatch(state, cue);
      if (rows.length) requestTranslation(state, rows);
    }
  }

  function startSession(state) {
    if (state.overlay) return;
    state.overlay = makeOverlay(state);
    state.tracks = [];
    state.failed = new Map();
    state.settingsAt = 0;
    state.settingsReady = false;
    state.observer = new MutationObserver(() => update(state));
    state.onMediaEvent = event => {
      if (event.type === "seeking" || event.type === "emptied") {
        cancelBatch(state);
        state.preSeekCue = state.cue ?? state.preSeekCue;
        setCue(state, undefined);
        render(state);
      }
      update(state);
    };
    for (const event of mediaEvents) state.video.addEventListener(event, state.onMediaEvent);
    document.dispatchEvent(new CustomEvent(trackRequestEvent, { detail: JSON.stringify({ videoId: state.id }) }));
    update(state);
  }

  function stopSession(state) {
    if (!state.overlay) return;
    cancelBatch(state);
    state.tracks = [];
    closeRequest(state.settingsRequest);
    state.settingsRequest = undefined;
    setCue(state, undefined);
    replaceNativeCaption(state, undefined);
    state.preSeekCue = undefined;
    state.observer.disconnect();
    state.observed = undefined;
    for (const event of mediaEvents) state.video.removeEventListener(event, state.onMediaEvent);
    state.overlay.interactions.destroy();
    state.overlay.root.remove();
    state.overlay = undefined;
  }

  function loseStatus(state) {
    closeRequest(state.status);
    state.status = undefined;
    stopSession(state);
    state.statusRetryAt = Date.now() + state.statusRetryDelay;
    state.statusRetryDelay = Math.min(state.statusRetryDelay * 2, 5_000);
  }

  function connectStatus(state) {
    const status = {};
    state.status = status;
    try {
      const port = chrome.runtime.connect({ name: "online-subtitle-status" });
      status.port = port;
      port.onMessage.addListener(message => {
        if (state.status !== status || !isCurrent(state)) return;
        if (message?.type !== "status" || typeof message.enabled !== "boolean" || Object.keys(message).length !== 2) {
          loseStatus(state);
          return;
        }
        clearTimeout(status.timer);
        state.statusRetryDelay = 500;
        if (message.enabled) startSession(state);
        else stopSession(state);
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (state.status === status && status.port) loseStatus(state);
      });
      status.timer = setTimeout(() => loseStatus(state), 5_000);
      port.postMessage({ type: "watchStatus" });
    } catch { loseStatus(state); }
  }

  function suspendWatch() {
    if (!watch) return;
    closeRequest(watch.status);
    watch.status = undefined;
    stopSession(watch);
  }

  function refresh() {
    if (polling === undefined) return;
    if (document.hidden) { suspendWatch(); return; }
    const id = watchId();
    const player = id && document.querySelector('div[data-uia="watch-video"]')
      ?.querySelector(`div[data-uia="player"][data-videoid="${id}"]`);
    const video = player?.querySelector("video");
    if (watch && (!isCurrent(watch) || watch.player !== player || watch.video !== video)) {
      suspendWatch();
      watch = undefined;
    }
    if (!video) return;
    watch ??= { id, player, video, cache: new Map(), statusRetryAt: 0, statusRetryDelay: 500 };
    if (!watch.status && Date.now() >= watch.statusRetryAt) connectStatus(watch);
    update(watch);
  }

  function start() {
    if (polling !== undefined) return;
    polling = setInterval(refresh, pollInterval);
    refresh();
  }

  document.addEventListener(trackResultEvent, readTrack);
  document.addEventListener("visibilitychange", refresh);
  window.addEventListener("popstate", refresh);
  window.addEventListener("focus", () => {
    if (watch?.overlay) watch.settingsAt = 0;
    refresh();
  });
  window.addEventListener("pageshow", start);
  window.addEventListener("pagehide", () => {
    clearInterval(polling);
    polling = undefined;
    suspendWatch();
    watch = undefined;
  });
  start();
})();
