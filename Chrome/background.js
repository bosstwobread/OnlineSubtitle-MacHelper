"use strict";

const host = "com.nelson007.online_subtitle";
const pageOrigin = "https://www.youtube.com";
const errorCodes = new Set(["unavailable", "busy", "model", "translation", "invalid"]);
const supportedLanguages = new Set(["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "pt", "it"]);
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

function boundedText(text, limit) {
  return typeof text === "string" && text.trim().length > 0 && text.length <= limit &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) && utf8.encode(text).length <= limit;
}

function isCue(cue, limit) {
  return cue && Number.isSafeInteger(cue.id) && cue.id > 0 && boundedText(cue.text, limit);
}

function hasKeys(value, ...keys) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validateRequest(message) {
  if (message?.type === "getSettings") {
    return hasKeys(message, "type") ? { type: "getSettings" } : null;
  }
  if (message?.type === "explainWord") {
    const { word, sentence } = message;
    if (!hasKeys(message, "type", "word", "sentence") || !boundedText(word, 256) ||
        !boundedText(sentence, 2000) || !sentence.includes(word)) return null;
    return { type: "explainWord", word, sentence };
  }
  if (!["translate", "translateSentences"].includes(message?.type) || !Array.isArray(message.cues) ||
      message.cues.length < 1 || message.cues.length > 8 ||
      !message.cues.every(cue => isCue(cue, 1000))) return null;
  if (new Set(message.cues.map(cue => cue.id)).size !== message.cues.length) return null;
  return { type: message.type, cues: message.cues.map(({ id, text }) => ({ id, text })) };
}

function readSettings(reply) {
  const { targetLanguage, revision } = reply;
  if (!supportedLanguages.has(targetLanguage) || typeof revision !== "string" ||
      revision.length !== 64 || !/^[0-9a-f]{64}$/.test(revision)) return null;
  return { targetLanguage, revision };
}

function sanitizeReply(reply, request) {
  const failure = { ok: false, error: "translation" };
  if (reply?.ok === false && hasKeys(reply, "ok", "error") && errorCodes.has(reply.error)) {
    return { ok: false, error: reply.error };
  }
  if (reply?.ok !== true) return failure;
  const settings = readSettings(reply);
  if (request.type === "getSettings") {
    return settings && hasKeys(reply, "ok", "targetLanguage", "revision") ? { ok: true, ...settings } : failure;
  }
  if (request.type === "explainWord") {
    const { meaning, sentenceMeaning } = reply;
    const keys = ["ok", "targetLanguage", "revision", "meaning"];
    const legacy = hasKeys(reply, ...keys, "sentenceMeaning") && boundedText(sentenceMeaning, 2000);
    if (!settings || !boundedText(meaning, 2000) || !(hasKeys(reply, ...keys) || legacy)) return failure;
    return { ok: true, ...settings, meaning };
  }
  if (!(hasKeys(reply, "ok", "translations") ||
        (settings && hasKeys(reply, "ok", "translations", "targetLanguage", "revision"))) ||
      !Array.isArray(reply.translations) ||
      reply.translations.length !== request.cues.length ||
      !reply.translations.every((cue, index) => isCue(cue, 2000) && cue.id === request.cues[index].id)) {
    return failure;
  }
  const translations = reply.translations.map(({ id, text, source }) => {
    const row = { id, text };
    if (request.type === "translateSentences" && boundedText(source, 1000)) {
      row.source = source;
    }
    return row;
  });
  return { ok: true, translations, ...settings };
}

function connectNative(watch) {
  return globalThis.onlineSubtitleConnectManaged?.(watch) ?? chrome.runtime.connectNative(host);
}

function connectStatus(port) {
  let native = null;
  let closed = false;

  function disconnect() {
    if (closed) return;
    closed = true;
    if (native) native.disconnect();
    port.disconnect();
  }

  port.onDisconnect.addListener(disconnect);
  port.onMessage.addListener(message => {
    if (closed) return;
    if (native || message?.type !== "watchStatus" || Object.keys(message).length !== 1) {
      disconnect();
      return;
    }
    try {
      native = connectNative(true);
      native.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        native = null;
        disconnect();
      });
      native.onMessage.addListener(update => {
        if (closed) return;
        if (update?.type !== "status" || typeof update.enabled !== "boolean" || Object.keys(update).length !== 2) {
          disconnect();
          return;
        }
        port.postMessage({ type: "status", enabled: update.enabled });
      });
      native.postMessage({ type: "watchStatus" });
    } catch {
      disconnect();
    }
  });
}

chrome.runtime.onConnect.addListener(port => {
  if (!isWatchPage(port.sender)) {
    port.disconnect();
    return;
  }
  if (port.name === "online-subtitle-status") {
    connectStatus(port);
    return;
  }
  if (port.name !== "online-subtitle-translate") {
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
      native = connectNative(false);
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
