(() => {
  "use strict";

  const origin = "https://www.netflix.com";
  if (location.origin !== origin || window.top !== window) return;

  const replaced = "data-online-subtitle-netflix-replaced";
  const captionSelector = ".player-timedtext";
  const pollInterval = 300;
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

  function readCue(node) {
    if (!node?.isConnected || node.hidden || !node.getClientRects().length) return;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return;
    const text = globalThis.onlineSubtitleRemoveSoundLabels(cleanText(node.innerText ?? node.textContent, 1_000));
    if (!text) return;
    const lang = node.getAttribute("lang");
    const language = lang && lang.length <= 40 && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(lang) ? lang : "";
    return { node, text, language, key: `${language}\0${text}` };
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

  function setCue(state, cue) {
    if (sameCue(state.cue, cue)) return;
    closeRequest(state.cue?.request);
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
      if (state.cue) {
        state.cue.finished = false;
        state.cue.failures = 0;
        state.cue.retryAt = 0;
      }
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

  function requestTranslation(state, cue) {
    const request = {};
    cue.request = request;
    sendRequest(request, { type: "translate", cues: [{ id: 1, text: cue.text }] }, 90_000, reply => {
      if (state.cue !== cue || cue.request !== request || !isCurrent(state)) return;
      cue.request = undefined;
      if (!sameCue(cue, sampleCue(state))) { update(state); return; }
      if (reply?.error === "busy" && (cue.failures ?? 0) < retryDelays.length) {
        cue.failures = (cue.failures ?? 0) + 1;
        cue.retryAt = Date.now() + retryDelays[cue.failures - 1];
        return;
      }
      cue.finished = true;
      const translations = reply?.translations;
      if (reply?.ok !== true || !validReplyConfiguration(reply) || !Array.isArray(translations) ||
          translations.length !== 1 || translations[0]?.id !== 1) return;
      const translation = onlineSubtitleRemoveSoundLabels(cleanText(translations[0].text, 2_000));
      if (!translation) return;
      const configuration = readConfiguration(reply);
      if (configuration) applyConfiguration(state, configuration);
      state.cache.set(cue.key, translation);
      if (state.cache.size > 128) state.cache.delete(state.cache.keys().next().value);
      render(state);
    });
  }

  function startLookup(state, rawWord) {
    const { cue } = state;
    const word = cleanText(rawWord, 256);
    if (!isCurrent(state) || !state.settingsReady || !cue || !state.cache.has(cue.key) ||
        !sameCue(cue, sampleCue(state)) || !word || !cue.text.includes(word)) return;
    dismissLookup(state);
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
    if (state.settingsRequest || cue?.request || state.lookup?.request) return;
    if (Date.now() >= state.settingsAt) requestSettings(state);
    else if (state.settingsReady && cue && !cue.finished && !state.cache.has(cue.key) &&
        Date.now() >= (cue.retryAt ?? 0)) requestTranslation(state, cue);
  }

  function startSession(state) {
    if (state.overlay) return;
    state.overlay = makeOverlay(state);
    state.settingsAt = 0;
    state.settingsReady = false;
    state.observer = new MutationObserver(() => update(state));
    state.onMediaEvent = event => {
      if (event.type === "seeking" || event.type === "emptied") {
        state.preSeekCue = state.cue ?? state.preSeekCue;
        setCue(state, undefined);
        render(state);
      }
      update(state);
    };
    for (const event of mediaEvents) state.video.addEventListener(event, state.onMediaEvent);
    update(state);
  }

  function stopSession(state) {
    if (!state.overlay) return;
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
