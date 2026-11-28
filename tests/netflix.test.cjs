const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = ["sound-labels.js", "netflix.js"]
  .map(file => readFileSync(path.join(__dirname, "../Chrome", file), "utf8")).join("\n");
const title = "81234567";
const replacement = "data-online-subtitle-netflix-replaced";
const defaultSettings = { ok: true, targetLanguage: "zh-CN", revision: "1".repeat(64) };

class Element extends EventTarget {
  isConnected = true;
  style = {};
  children = [];
  attrs = new Map();
  textContent = "";

  append(...children) {
    for (const child of children) {
      this.children.push(child);
      child.parent = this;
    }
  }

  contains(child) { return this.children.includes(child); }
  getClientRects() { return this.hasBox === false ? [] : [{}]; }
  setAttribute(name, value) { this.attrs.set(name, value); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  removeAttribute(name) { this.attrs.delete(name); }
  remove() {
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.isConnected = false;
  }
}

function signal() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(value) { for (const listener of listeners) listener(value); }
  };
}

function browser({ route = `/watch/${title}`, playerId = title, initialText = "", topFrame = true } = {}) {
  const location = { origin: "https://www.netflix.com", pathname: route };
  const window = new EventTarget();
  window.top = topFrame ? window : undefined;
  const document = new EventTarget();
  document.hidden = false;
  const host = new Element();
  const player = new Element();
  const video = new Element();
  const native = new Element();
  host.append(player);
  player.append(video, native);
  player.setAttribute("data-videoid", playerId);
  native.textContent = initialText;
  native.setAttribute("lang", "en");
  video.HAVE_METADATA = video.readyState = 1;
  video.pause = () => { video.paused = true; };
  host.querySelector = selector => selector === `div[data-uia="player"][data-videoid="${player.getAttribute("data-videoid")}"]` ? player : null;
  player.querySelector = selector => ({ video, ".player-timedtext": native })[selector];
  document.querySelector = selector => selector === 'div[data-uia="watch-video"]' ? host : null;
  document.createElement = () => new Element();

  const ports = [];
  const intervals = new Map();
  const observers = new Map();
  let settings = defaultSettings;
  let interactions;
  let now = 0;
  let timerId = 0;
  vm.runInNewContext(source, {
    location, window, document, TextEncoder,
    Date: class extends Date { static now() { return now; } },
    getComputedStyle: node => node.style,
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(node) { observers.set(this, node); }
      disconnect() { observers.delete(this); }
    },
    setInterval(callback) { intervals.set(++timerId, callback); return timerId; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout() { return ++timerId; },
    clearTimeout() {},
    chrome: { runtime: {
      connect({ name }) {
        assert.ok(["online-subtitle-status", "online-subtitle-translate"].includes(name));
        const port = {
          onMessage: signal(), onDisconnect: signal(), disconnected: false,
          postMessage(message) {
            this.sent = structuredClone(message);
            if (message.type === "getSettings") this.onMessage.emit(settings);
          },
          disconnect() {
            if (this.disconnected) return;
            this.disconnected = true;
            this.onDisconnect.emit();
          }
        };
        ports.push(port);
        return port;
      }
    } },
    onlineSubtitleCreateInteractions({ original, onWord }) {
      interactions = {
        onWord,
        renderSource(text) { original.textContent = text; },
        showLookup(word) { this.lookup = { word }; },
        completeLookup(reply) { this.lookup = { ...this.lookup, ...reply }; },
        failLookup() { this.lookup.failed = true; },
        closeLookup() { this.lookup = undefined; },
        destroy() { this.destroyed = true; }
      };
      return interactions;
    }
  });

  const statusPorts = () => ports.filter(port => port.sent.type === "watchStatus");
  return {
    document, window, location, native, player, video, ports,
    get statusPort() { return statusPorts().at(-1); },
    get translationPorts() { return ports.filter(port => port.sent.type === "translate"); },
    get overlay() { return player.children.find(child => child.className === "online-subtitle-overlay"); },
    get input() { return this.overlay?.children[0]?.children[0].textContent; },
    get translation() { return this.overlay?.children[0]?.children[1].textContent; },
    get masked() { return native.attrs.has(replacement); },
    get lookup() { return interactions.lookup; },
    status(enabled, port = this.statusPort) { port.onMessage.emit({ type: "status", enabled }); },
    setCue(text, display = "block") {
      native.textContent = text;
      native.style.display = display;
      for (const [observer, node] of observers) if (node === native) observer.callback();
    },
    focus(configuration) {
      settings = configuration;
      window.dispatchEvent(new Event("focus"));
    },
    refresh(delay = 0) {
      now += delay;
      for (const callback of intervals.values()) callback();
    },
    lookupWord(word) { interactions.onWord(word); }
  };
}

function complete(port, text, settings = defaultSettings) {
  port.onMessage.emit({ ...settings, translations: [{ id: 1, text }] });
}

test("requires a top-frame watch route, its matching player and an enabled MacHelper connection", () => {
  const frame = browser({ topFrame: false });
  assert.equal(frame.ports.length, 0);
  const page = browser({ route: "/browse", playerId: "999", initialText: "Hello. [Music]" });
  assert.equal(page.ports.length, 0);
  page.location.pathname = `/watch/${title}`;
  page.refresh();
  assert.equal(page.ports.length, 0);
  page.player.setAttribute("data-videoid", title);
  page.refresh();
  assert.equal(page.ports.length, 1);
  assert.equal(page.overlay, undefined);
  page.status(true);
  assert.deepEqual(page.translationPorts[0].sent, { type: "translate", cues: [{ id: 1, text: "Hello." }] });
  assert.equal(page.masked, false);
  complete(page.translationPorts[0], "你好。 ");
  assert.equal(page.input, "Hello.");
  assert.equal(page.translation, "你好。");
  assert.equal(page.masked, true);
});

test("renders only the current Netflix cue, preserves gaps and invalidates cached translations on settings changes", () => {
  const page = browser({ initialText: "First line." });
  page.status(true);
  const first = page.translationPorts[0];
  page.setCue("Second line.");
  assert.equal(first.disconnected, true);
  complete(first, "第一句。");
  assert.equal(page.masked, false);
  const second = page.translationPorts[1];
  complete(second, "第二句。");
  assert.equal(page.translation, "第二句。");
  assert.equal(page.masked, true);

  page.setCue("Second line.", "none");
  assert.equal(page.masked, false);
  assert.equal(page.translation, "");
  page.setCue("Second line.");
  assert.equal(page.translationPorts.length, 2);
  assert.equal(page.translation, "第二句。");
  page.native.hasBox = false;
  page.refresh();
  assert.equal(page.masked, false);
  assert.equal(page.translation, "");
  page.native.hasBox = true;
  page.refresh();
  assert.equal(page.translation, "第二句。");
  const french = { ok: true, targetLanguage: "fr", revision: "2".repeat(64) };
  page.focus(french);
  assert.equal(page.masked, false);
  complete(page.translationPorts[2], "Deuxième ligne.", french);
  assert.equal(page.translation, "Deuxième ligne.");
});

test("restores the source on seeking, status disconnect and a different Netflix watch route", () => {
  const page = browser({ initialText: "Before seek." });
  page.status(true);
  complete(page.translationPorts[0], "跳转之前。");
  page.video.seeking = true;
  page.video.dispatchEvent(new Event("seeking"));
  assert.equal(page.masked, false);
  page.video.seeking = false;
  page.video.dispatchEvent(new Event("seeked"));
  assert.equal(page.masked, false);
  assert.equal(page.translationPorts.length, 1);
  page.setCue("After seek.");
  const after = page.translationPorts[1];
  page.statusPort.disconnect();
  assert.equal(after.disconnected, true);
  assert.equal(page.overlay, undefined);
  page.refresh(500);
  page.status(true);
  const next = page.translationPorts[2];
  page.location.pathname = "/watch/999";
  complete(next, "跳转之后。");
  assert.equal(page.masked, false);
  page.refresh();
  assert.equal(page.overlay, undefined);
});

test("cancels active cue work on hiding or disabling Netflix subtitles", () => {
  const page = browser({ initialText: "A visible subtitle." });
  page.status(true);
  const request = page.translationPorts[0];
  page.document.hidden = true;
  page.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(request.disconnected, true);
  assert.equal(page.overlay, undefined);
  page.document.hidden = false;
  page.document.dispatchEvent(new Event("visibilitychange"));
  page.status(true);
  complete(page.translationPorts[1], "可见的字幕。");
  assert.equal(page.masked, true);
  page.status(false);
  assert.equal(page.masked, false);
  assert.equal(page.overlay, undefined);
});

test("tries a busy Netflix cue at most three more times with native captions available", () => {
  const page = browser({ initialText: "A busy subtitle." });
  page.status(true);
  for (const [index, delay] of [500, 1_000, 2_000].entries()) {
    page.translationPorts[index].onMessage.emit({ ok: false, error: "busy" });
    assert.equal(page.masked, false);
    page.refresh(delay - 1);
    assert.equal(page.translationPorts.length, index + 1);
    page.refresh(1);
    assert.equal(page.translationPorts.length, index + 2);
  }
  page.translationPorts[3].onMessage.emit({ ok: false, error: "busy" });
  page.refresh(60_000);
  assert.equal(page.translationPorts.length, 4);
  assert.equal(page.masked, false);
});

test("sends only the visible cue for contextual word lookup", () => {
  const page = browser({ initialText: "A contextual word." });
  page.status(true);
  complete(page.translationPorts[0], "一个语境中的单词。");
  page.lookupWord("contextual");
  const lookup = page.ports.at(-1);
  assert.deepEqual(lookup.sent, { type: "explainWord", word: "contextual", sentence: "A contextual word." });
  assert.equal(page.video.paused, true);
  lookup.onMessage.emit({ ...defaultSettings, meaning: "与上下文相关的" });
  assert.equal(page.lookup.meaning, "与上下文相关的");
  page.setCue("The next line.");
  assert.equal(page.lookup, undefined);
});
