const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const script = readFileSync(join(__dirname, "../Chrome/netflix-timedtext.js"), "utf8");
const requestEvent = "online-subtitle:netflix-request";
const trackEvent = "online-subtitle:netflix-track";
const subtitleURL = "https://example.oca.nflxvideo.net/?opaque-fixture";
const vtt = "WEBVTT\n\n1\n00:01.200 --> 00:03.200 align:center\n<i>Tea</i> &amp; milk.\n\n00:04.000 --> 00:06.500\nNext line.\n";

function fixture({ video, xml, fetch } = {}) {
  const document = new EventTarget();
  const window = new EventTarget();
  window.top = window;
  window.fetch = fetch ?? (() => { throw new Error("Unexpected network request"); });
  const location = new URL("https://www.netflix.com/watch/123");
  document.querySelector = selector => selector.includes('data-videoid="123"') ? video : null;
  const events = [];
  document.addEventListener(trackEvent, event => events.push(JSON.parse(event.detail)));
  class XHR extends EventTarget {
    getResponseHeader(key) { return this.headers[key.toLowerCase()] ?? null; }
    send() {}
  }
  class DOMParser {
    parseFromString(source, format) {
      assert.match(source, /^<tt\b/);
      assert.equal(format, "application/xml");
      return xml;
    }
  }
  vm.runInNewContext(script, {
    document, window, location, XMLHttpRequest: XHR, DOMParser, TextDecoder, TextEncoder, URL, CustomEvent,
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, SHOW_CDATA_SECTION: 8 },
  });
  const request = (videoId = "123") => document.dispatchEvent(new CustomEvent(requestEvent, { detail: JSON.stringify({ videoId }) }));
  function begin({ type = "text", mime = "text/vtt; charset=UTF-8", url = subtitleURL, length } = {}) {
    const xhr = new XHR();
    Object.assign(xhr, { responseType: type, status: 200, responseURL: url, headers: { "content-type": mime, "content-length": length } });
    xhr.send();
    return xhr;
  }
  return { document, window, location, events, request, begin };
}

function complete(xhr, source) {
  if (xhr.responseType === "text") xhr.responseText = source;
  else if (xhr.responseType === "document") xhr.responseXML = source;
  else xhr.response = source;
  xhr.dispatchEvent(new Event("loadend"));
}

test("replays a bounded WebVTT track that arrived before the companion was ready", () => {
  const page = fixture();
  complete(page.begin(), vtt);
  assert.equal(page.events.length, 0);
  page.request("456");
  assert.equal(page.events.length, 0);
  page.request();
  assert.deepEqual(page.events, [{ videoId: "123", cues: [
    { start: 1.2, end: 3.2, text: "Tea & milk." }, { start: 4, end: 6.5, text: "Next line." },
  ] }]);
  page.location.pathname = "/watch/456";
  page.request("456");
  assert.equal(page.events.length, 1);
});

test("accepts TTML ticks, clock times and multiline spans from the existing CDN XML response", async () => {
  const rows = [
    { begin: "12500t", end: "15750t", parts: ["First", null, "line."] },
    { begin: "00:00:17.125", dur: "375ms", parts: ["Next."] },
  ];
  const paragraphs = rows.map(row => ({
    getAttribute: key => row[key] ?? null, hasAttribute: key => key in row,
    nodes: row.parts.map(part => part === null ? { nodeType: 1, localName: "br" } : { nodeType: 3, data: part }),
  }));
  const xml = {
    documentElement: {
      localName: "tt",
      getElementsByTagNameNS: () => paragraphs,
      getAttributeNS: (_, key) => ({ tickRate: "1000", lang: "en" })[key] ?? "",
    },
    createTreeWalker(p) {
      const iterator = p.nodes.values();
      return { nextNode: () => iterator.next().value };
    },
  };
  for (const [type, source] of [["document", xml], ["arraybuffer", new TextEncoder().encode("<tt/>").buffer],
                                 ["blob", new Blob(["<tt/>"])], ["text", "<tt/>"]]) {
    const page = fixture({ xml });
    page.request();
    complete(page.begin({ mime: "text/xml", type }), source);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(page.events[0], { videoId: "123", cues: [
      { start: 12.5, end: 15.75, text: "First line." }, { start: 17.125, end: 17.5, text: "Next." },
    ], language: "en" });
  }
});

test("ignores media, unrelated hosts, stale titles and oversized responses without reading the body", () => {
  const page = fixture();
  page.request();
  for (const options of [{ mime: "video/mp4" }, { mime: "application/octet-stream" }, { url: "https://www.netflix.com/account" },
                         { url: "https://a.nflxvideo.net.invalid/x" }, { length: String(3 * 1024 * 1024) }]) {
    const xhr = page.begin(options);
    let read = false;
    Object.defineProperty(xhr, "responseText", { get() { read = true; return vtt; } });
    xhr.dispatchEvent(new Event("loadend"));
    assert.equal(read, false);
  }
  const xhr = page.begin();
  page.location.pathname = "/watch/999";
  complete(xhr, vtt);
  page.request("999");
  assert.equal(page.events.length, 0);
});

test("can observe a subtitle fetched by the page without changing the original response", async () => {
  const response = new Response(vtt, { headers: { "Content-Type": "text/vtt" } });
  Object.defineProperty(response, "url", { value: subtitleURL });
  const promise = Promise.resolve(response);
  let count = 0;
  const page = fixture({ fetch() { count++; return promise; } });
  page.request();
  assert.equal(page.window.fetch(subtitleURL), promise);
  assert.equal(await (await promise).text(), vtt);
  for (let attempt = 0; !page.events.length && attempt < 20; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.events[0].cues[0].start, 1.2);
  assert.equal(count, 1);
});

test("uses matching player text tracks that already expose timed caption cues", () => {
  const captions = { kind: "captions", mode: "showing", language: "en", cues: [{ startTime: 1, endTime: 3, text: "First." }] };
  const page = fixture({ video: { textTracks: [captions, { ...captions, kind: "metadata" }] } });
  page.request();
  assert.deepEqual(page.events, [{ videoId: "123", cues: [{ start: 1, end: 3, text: "First." }], language: "en" }]);
});
