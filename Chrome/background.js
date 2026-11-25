"use strict";

const host = "com.nelson007.online_subtitle";
const pageOrigin = "https://www.youtube.com";
const errorCodes = new Set(["unavailable", "busy", "model", "translation", "invalid"]);
const utf8 = new TextEncoder();

function isWatchPage(sender) {
  if (sender?.id !== chrome.runtime.id || sender.frameId !== 0 || sender.origin !== pageOrigin ||
      !Number.isInteger(sender.tab?.id) || typeof sender.url !== "string") return false;
  try {
    const url = new URL(sender.url);
    return url.origin === pageOrigin && url.pathname === "/watch" &&
      /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get("v") ?? "");
  } catch {
    return false;
  }
}

function isCue(cue, limit) {
  return cue && Number.isSafeInteger(cue.id) && cue.id > 0 && typeof cue.text === "string" &&
    cue.text.trim().length > 0 && cue.text.length <= limit && !cue.text.includes("\0") &&
    utf8.encode(cue.text).length <= limit;
}

function validateRequest(message) {
  if (message?.type !== "translate" || !Array.isArray(message.cues) ||
      message.cues.length < 1 || message.cues.length > 8 ||
      !message.cues.every(cue => isCue(cue, 1000))) return null;
  if (new Set(message.cues.map(cue => cue.id)).size !== message.cues.length) return null;
  return { type: "translate", cues: message.cues.map(({ id, text }) => ({ id, text })) };
}

function sanitizeReply(reply, request) {
  if (reply?.ok === false && errorCodes.has(reply.error)) return { ok: false, error: reply.error };
  if (reply?.ok !== true || !Array.isArray(reply.translations) ||
      reply.translations.length !== request.cues.length ||
      !reply.translations.every((cue, index) => isCue(cue, 2000) && cue.id === request.cues[index].id)) {
    return { ok: false, error: "translation" };
  }
  return { ok: true, translations: reply.translations.map(({ id, text }) => ({ id, text })) };
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "online-subtitle-translate" || !isWatchPage(port.sender)) {
    port.disconnect();
    return;
  }
  let native = null;
  let closed = false;
  let started = false;

  function finish(reply) {
    if (closed) return;
    closed = true;
    if (native) native.disconnect();
    port.postMessage(reply);
    port.disconnect();
  }

  port.onDisconnect.addListener(() => {
    closed = true;
    if (native) native.disconnect();
  });

  port.onMessage.addListener(message => {
    if (closed) return;
    if (started) {
      finish({ ok: false, error: "invalid" });
      return;
    }
    started = true;
    const request = validateRequest(message);
    if (!request) {
      finish({ ok: false, error: "invalid" });
      return;
    }
    try {
      native = chrome.runtime.connectNative(host);
      native.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        native = null;
        finish({ ok: false, error: "unavailable" });
      });
      native.onMessage.addListener(reply => finish(sanitizeReply(reply, request)));
      native.postMessage(request);
    } catch {
      finish({ ok: false, error: "unavailable" });
    }
  });
});
