"use strict";

(() => {
  const host = "com.localaibasetools.companion";
  const extension = "com.nelson007.online-subtitle";
  const pollInterval = 4_000;
  const maximumPayloadBytes = 32 * 1024;
  const encoder = new TextEncoder();
  const commands = Object.freeze({
    translate: "translate-captions",
    translateSentences: "translate-captions",
    getSettings: "caption-settings",
    explainWord: "explain-word",
  });
  const errors = Object.freeze({
    invalid: "invalid",
    unavailable: "unavailable",
    busy: "busy",
    failed: "translation",
  });

  function envelope(request, watch) {
    if (watch) {
      return { type: globalThis.onlineSubtitleSafari ? "getStatus" : "watchStatus", extension };
    }
    return { type: "invoke", extension, command: commands[request.type], payload: JSON.stringify(request) };
  }

  function commandReply(reply) {
    if (reply?.ok === false && typeof reply.error === "string" && Object.hasOwn(errors, reply.error)) {
      return { ok: false, error: errors[reply.error] };
    }
    if (reply?.ok === true && typeof reply.payload === "string" &&
        reply.payload.length <= maximumPayloadBytes && encoder.encode(reply.payload).length <= maximumPayloadBytes) {
      try { return JSON.parse(reply.payload); } catch {}
    }
    return { ok: false, error: "translation" };
  }

  function connectStreaming(watch) {
    const native = chrome.runtime.connectNative(host);
    return {
      onDisconnect: native.onDisconnect,
      onMessage: {
        addListener(listener) {
          native.onMessage.addListener(watch ? listener : reply => listener(commandReply(reply)));
        },
      },
      postMessage(request) { native.postMessage(envelope(request, watch)); },
      disconnect() { native.disconnect(); },
    };
  }

  function connectSafari(watch) {
    let closed = false;
    let timer;
    let onMessage;
    let onDisconnect;

    async function send(request) {
      try {
        const reply = await browser.runtime.sendNativeMessage(host, request);
        if (closed) return;
        onMessage(watch ? reply : commandReply(reply));
        if (watch && !closed) timer = setTimeout(() => { void send(request); }, pollInterval);
      } catch {
        if (!closed) onDisconnect();
      }
    }

    return {
      onMessage: { addListener(listener) { onMessage = listener; } },
      onDisconnect: { addListener(listener) { onDisconnect = listener; } },
      postMessage(request) { void send(envelope(request, watch)); },
      disconnect() {
        closed = true;
        clearTimeout(timer);
      },
    };
  }

  globalThis.onlineSubtitleConnectManaged = globalThis.onlineSubtitleSafari ? connectSafari : connectStreaming;
})();
