(() => {
  "use strict";

  if (location.origin !== "https://www.netflix.com" || window !== window.top) return;
  const maxBytes = 2 * 1024 * 1024;
  const maxCues = 4_000;
  const encoder = new TextEncoder();
  const requestEvent = "online-subtitle:netflix-request";
  const trackEvent = "online-subtitle:netflix-track";
  const ttmlParameters = "http://www.w3.org/ns/ttml#parameter";
  const xmlNamespace = "http://www.w3.org/XML/1998/namespace";
  let episode;
  let requested = false;
  let tracks = [];

  function watchId() {
    const id = /^\/watch\/([0-9]{1,20})$/.exec(location.pathname)?.[1];
    if (episode !== id) {
      episode = id;
      requested = false;
      tracks = [];
    }
    return id;
  }

  function addCue(cues, start, end, rawText) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start ||
        end > 24 * 3600 || typeof rawText !== "string" || rawText.length > 2_000) return;
    const text = rawText.replace(/\s+/gu, " ").trim();
    if (text && encoder.encode(text).length <= 1_000) cues.push({ start, end, text });
  }

  function remember(id, cues, lang) {
    if (!id || id !== watchId() || !cues.length || cues.length > maxCues) return;
    cues.sort((a, b) => a.start - b.start || a.end - b.end);
    const language = typeof lang === "string" && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(lang) && lang.length <= 40
      ? lang : undefined;
    const detail = JSON.stringify({ videoId: id, cues, language });
    if (detail.length > maxBytes || encoder.encode(detail).length > maxBytes || tracks.includes(detail)) return;
    tracks.push(detail);
    if (tracks.length > 4) tracks.shift();
    if (requested) document.dispatchEvent(new CustomEvent(trackEvent, { detail }));
  }

  function clockTime(value) {
    const clock = /^(?:(\d+):)?([0-5]\d):([0-5]\d(?:\.\d+)?)$/.exec(value);
    return clock ? Number(clock[1] || 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) : NaN;
  }

  function ttmlTime(value, tickRate, frameRate) {
    const offset = /^(\d+(?:\.\d+)?)(ms|h|m|s|t|f)$/.exec(value);
    if (offset) {
      const seconds = { h: 3600, m: 60, s: 1, ms: 0.001, t: 1 / tickRate, f: 1 / frameRate };
      return Number(offset[1]) * seconds[offset[2]];
    }
    const frames = /^(\d+:\d\d:\d\d):(\d+)$/.exec(value);
    return frames ? clockTime(frames[1]) + Number(frames[2]) / frameRate : clockTime(value);
  }

  function readTTML(id, xml) {
    const root = xml?.documentElement;
    if (root?.localName !== "tt" || xml.doctype) return;
    const paragraphs = root.getElementsByTagNameNS("*", "p");
    if (paragraphs.length > maxCues) return;
    const rate = Number(root.getAttributeNS(ttmlParameters, "frameRate")) || 30;
    const ratio = /^(\d+)\s+(\d+)$/.exec(root.getAttributeNS(ttmlParameters, "frameRateMultiplier"));
    const frameRate = ratio ? rate * Number(ratio[1]) / Number(ratio[2]) : rate;
    const tickRate = Number(root.getAttributeNS(ttmlParameters, "tickRate")) || 10_000_000;
    const cues = [];
    for (const p of paragraphs) {
      const start = ttmlTime(p.getAttribute("begin"), tickRate, frameRate);
      const end = p.hasAttribute("end") ? ttmlTime(p.getAttribute("end"), tickRate, frameRate)
        : start + ttmlTime(p.getAttribute("dur"), tickRate, frameRate);
      const walker = xml.createTreeWalker(p, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_CDATA_SECTION);
      let text = "";
      for (let node; text.length <= 2_000 && (node = walker.nextNode());) {
        if (node.nodeType === 3 || node.nodeType === 4) text += node.data;
        else if (node.localName === "br") text += " ";
      }
      addCue(cues, start, end, text);
    }
    remember(id, cues, root.getAttributeNS(xmlNamespace, "lang"));
  }

  function readVTT(id, source) {
    const cues = [];
    for (const block of source.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/)) {
      const lines = block.trim().split("\n");
      if (/^(?:WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])) continue;
      const i = lines[0].includes("-->") ? 0 : 1;
      const times = /^(\S+)\s+-->\s+(\S+)(?:[ \t].*)?$/.exec(lines[i]);
      if (!times) continue;
      const text = lines.slice(i + 1).join(" ").replace(/<[^>\n]{1,80}>/g, "")
        .replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (_, key) => ({
          amp: "&", lt: "<", gt: ">", nbsp: " ", lrm: "\u200e", rlm: "\u200f"
        })[key]);
      addCue(cues, clockTime(times[1]), clockTime(times[2]), text);
      if (cues.length > maxCues) return;
    }
    remember(id, cues);
  }

  function parseText(id, source) {
    if (watchId() !== id || !source || source.length > maxBytes || encoder.encode(source).length > maxBytes) return;
    const text = source.trimStart();
    if (/^WEBVTT(?:\s|$)/.test(text)) readVTT(id, text);
    else if (text.startsWith("<") && !/<!DOCTYPE|<!ENTITY/i.test(text)) {
      readTTML(id, new DOMParser().parseFromString(text, "application/xml"));
    }
  }

  function isSubtitleResponse(url, type, length) {
    if (!url || Number(length) > maxBytes ||
        !/^(?:text\/(?:xml|vtt)|application\/(?:xml|ttml\+xml))(?:\s*;|$)/i.test(type || "")) return false;
    const address = new URL(url);
    return address.protocol === "https:" && address.hostname.endsWith(".nflxvideo.net");
  }

  async function inspectXHR(xhr, id) {
    if (!id || id !== watchId() || xhr.status !== 200 && xhr.status !== 206 ||
        !isSubtitleResponse(xhr.responseURL, xhr.getResponseHeader("Content-Type"), xhr.getResponseHeader("Content-Length"))) return;
    switch (xhr.responseType) {
      case "document":
        readTTML(id, xhr.responseXML);
        break;
      case "arraybuffer":
        if (xhr.response && xhr.response.byteLength <= maxBytes) parseText(id, new TextDecoder().decode(xhr.response));
        break;
      case "blob":
        if (xhr.response && xhr.response.size <= maxBytes) parseText(id, await xhr.response.text());
        break;
      case "":
      case "text":
        parseText(id, xhr.responseText);
        break;
    }
  }

  // Observe only a completed subtitle response already requested by the player.
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    const startId = watchId();
    const complete = () => { inspectXHR(this, startId ?? watchId()).catch(() => {}); };
    this.addEventListener("loadend", complete, { once: true });
    try { return Reflect.apply(send, this, args); }
    catch (error) { this.removeEventListener("loadend", complete); throw error; }
  };

  async function inspectFetch(response, startId) {
    const id = startId ?? watchId();
    if (!id || id !== watchId() || !response.ok || !response.body ||
        !isSubtitleResponse(response.url, response.headers.get("Content-Type"), response.headers.get("Content-Length"))) return;
    const reader = response.clone().body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let source = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes || watchId() !== id) {
          reader.cancel().catch(() => {});
          return;
        }
        source += decoder.decode(value, { stream: true });
      }
      parseText(id, source + decoder.decode());
    } finally {
      reader.releaseLock();
    }
  }

  const fetch = window.fetch;
  window.fetch = function (...args) {
    const id = watchId();
    const result = Reflect.apply(fetch, this, args);
    result.then(response => inspectFetch(response, id)).catch(() => {});
    return result;
  };

  function readTextTracks(id) {
    const player = document.querySelector(`[data-uia="watch-video"] [data-uia="player"][data-videoid="${id}"] video`);
    if (!player) return;
    for (const track of player.textTracks) {
      if (!["captions", "subtitles"].includes(track.kind) || track.mode === "disabled" ||
          !track.cues || track.cues.length > maxCues) continue;
      const cues = [];
      for (const cue of track.cues) addCue(cues, cue.startTime, cue.endTime, cue.text);
      remember(id, cues, track.language);
    }
  }

  document.addEventListener(requestEvent, event => {
    const id = watchId();
    if (!id || typeof event.detail !== "string" || event.detail.length > 128) return;
    try {
      if (JSON.parse(event.detail)?.videoId !== id) return;
      requested = false;
      readTextTracks(id);
      requested = true;
      for (const detail of tracks) document.dispatchEvent(new CustomEvent(trackEvent, { detail }));
    } catch { /* The player may have replaced the video. */ }
  });
  window.addEventListener("pagehide", () => {
    episode = undefined;
    tracks = [];
    requested = false;
  });
})();
