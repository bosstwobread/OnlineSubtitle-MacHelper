const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = readFileSync(path.join(__dirname, "../Chrome/content.js"), "utf8");
const videoId = "AbCdeFghI-1";
const otherVideoId = "123456789ab";

class ClassList extends Set {
  contains(name) { return this.has(name); }
}

class Element extends EventTarget {
  children = [];
  attributes = new Map();
  classList = new ClassList();
  parent = null;
  isConnected = true;
  textContent = "";

  append(...children) {
    for (const child of children) {
      this.children.push(child);
      child.parent = this;
    }
  }

  querySelector(selector) {
    assert.match(selector, /^video/);
    return this.children.find(child => child.isVideo) ?? null;
  }

  contains(child) {
    return this.children.includes(child);
  }

  remove() {
    this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
    this.isConnected = false;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  toggleAttribute(name, enabled) {
    if (enabled) this.setAttribute(name, "");
    else this.removeAttribute(name);
  }
}

function signal() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(value) { for (const listener of listeners) listener(value); }
  };
}

function browser({ id = videoId, currentTime = 0, hidden = false } = {}) {
  const location = { origin: "https://www.youtube.com", pathname: "/watch", search: `?v=${id}` };
  const document = new EventTarget();
  const window = new EventTarget();
  const requests = [];
  const ports = [];
  const observers = [];
  const microtasks = [];
  const timers = new Map();
  const intervals = new Map();
  let timerId = 0;
  let player;
  let video;

  function mount(time = currentTime) {
    if (player) player.isConnected = false;
    if (video) video.isConnected = false;
    player = new Element();
    video = Object.assign(new Element(), { isVideo: true, currentTime: time, seeking: false });
    player.append(video);
  }

  mount();
  document.hidden = hidden;
  document.createElement = () => new Element();
  document.getElementById = name => name === "movie_player" ? player : null;
  document.addEventListener("online-subtitle-request-captions", event => requests.push(event.detail));
  window.top = window;
  vm.runInNewContext(script, {
    chrome: { runtime: {
      connect(options) {
        assert.equal(options.name, "online-subtitle-translate");
        const port = {
          disconnected: false,
          onDisconnect: signal(),
          onMessage: signal(),
          disconnect() {
            if (this.disconnected) return;
            this.disconnected = true;
            this.onDisconnect.emit();
          },
          postMessage(message) { this.sent = structuredClone(message); }
        };
        ports.push(port);
        return port;
      }
    } },
    document,
    window,
    location,
    TextEncoder,
    URLSearchParams,
    CustomEvent,
    crypto,
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.push(this.callback); }
      disconnect() { observers.splice(observers.indexOf(this.callback), 1); }
    },
    queueMicrotask: callback => microtasks.push(callback),
    setInterval(callback) { intervals.set(++timerId, callback); return timerId; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  });

  return {
    document, window, location, requests, ports, mount,
    get player() { return player; },
    get video() { return video; },
    get overlay() {
      const root = player.children.find(child => child.className === "online-subtitle-overlay");
      return {
        root, lines: root?.children[0], original: root?.children[0]?.children[0],
        translation: root?.children[0]?.children[1], status: root?.children[1]
      };
    },
    captions(cues, { request = requests.at(-1), sourceLanguage = "en", error } = {}) {
      document.dispatchEvent(new CustomEvent("online-subtitle-captions", { detail: { ...request, cues, sourceLanguage, error } }));
    },
    playAt(time, event = "timeupdate") {
      video.currentTime = time;
      video.dispatchEvent(new Event(event));
    },
    ad(active) {
      if (active) player.classList.add("ad-showing");
      else player.classList.delete("ad-showing");
      for (const observer of observers) observer();
    },
    refresh() { for (const interval of intervals.values()) interval(); },
    runMicrotasks() { while (microtasks.length) microtasks.shift()(); },
    runTimers(delay) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay === delay) { timers.delete(id); timer.callback(); }
      }
    }
  };
}

const cues = Array.from({ length: 14 }, (_, index) => ({ start: index * 5, end: index * 5 + 4, text: `Sentence ${index + 1}` }));

function translate(batches, port) {
  batches.push(port.sent.cues.map(cue => cue.id));
  port.onMessage.emit({ ok: true, translations: port.sent.cues.map(({ id }) => ({ id, text: `第${id}句` })).reverse() });
}

test("shows source immediately, translates the playhead first, then covers every cue", () => {
  const page = browser({ currentTime: 32 });
  assert.equal(page.requests.length, 1);
  page.captions(cues);
  assert.equal(page.overlay.original.textContent, "Sentence 7");
  assert.equal(page.overlay.translation.hidden, true);
  assert.deepEqual(page.ports[0].sent, { type: "translate", cues: [7, 8, 9].map(id => ({ id, text: `Sentence ${id}` })) });

  const batches = [];
  for (const port of page.ports) {
    translate(batches, port);
    page.runMicrotasks();
  }
  assert.equal(page.overlay.translation.textContent, "第7句");
  assert.ok(batches.every(batch => batch.length <= 8));
  assert.deepEqual(batches.flat().sort((a, b) => a - b), cues.map((_, index) => index + 1));
  page.playAt(34.5);
  assert.equal(page.overlay.lines.hidden, true);
  assert.equal(page.player.attributes.has("data-online-subtitle-visible"), false);
  page.playAt(51);
  assert.equal(page.overlay.translation.textContent, "第11句");
});

test("cancels far-away translation after a seek and ignores the stale response", () => {
  const page = browser();
  page.captions(cues);
  const originalPort = page.ports[0];
  page.video.seeking = true;
  page.playAt(62, "seeking");
  assert.equal(page.overlay.lines.hidden, true);
  page.video.seeking = false;
  page.playAt(62, "seeked");
  assert.equal(originalPort.disconnected, true);
  assert.equal(page.ports.length, 2);
  assert.deepEqual(page.ports[1].sent.cues.map(cue => cue.id), [1, 13, 14]);
  translate([], originalPort);
  assert.equal(page.overlay.original.textContent, "Sentence 13");
  assert.equal(page.overlay.translation.hidden, true);
});

test("hides labels during ads and while the tab is hidden, then resumes the same track", () => {
  const page = browser();
  page.captions(cues);
  page.ad(true);
  assert.equal(page.overlay.lines.hidden, true);
  assert.equal(page.ports[0].disconnected, true);
  page.ad(false);
  assert.equal(page.overlay.original.textContent, "Sentence 1");
  page.document.hidden = true;
  page.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(page.overlay.lines.hidden, true);
  assert.equal(page.ports[1].disconnected, true);
  page.document.hidden = false;
  page.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(page.overlay.original.textContent, "Sentence 1");
  assert.equal(page.requests.length, 1);
  assert.equal(page.ports.length, 3);
});

test("discards stale track and translation results when a video or player changes", () => {
  const page = browser();
  const oldRequest = page.requests[0];
  page.captions(cues);
  const oldPort = page.ports[0];
  page.document.dispatchEvent(new Event("yt-navigate-start"));
  assert.equal(page.overlay.root, undefined);
  assert.equal(oldPort.disconnected, true);
  page.location.search = `?v=${otherVideoId}`;
  page.document.dispatchEvent(new Event("yt-navigate-finish"));
  page.captions(cues, { request: oldRequest });
  translate([], oldPort);
  assert.equal(page.overlay.lines.hidden, true);
  assert.equal(page.ports.length, 1);
  page.captions([{ start: 0, end: 4, text: "New video" }]);
  assert.equal(page.overlay.original.textContent, "New video");
  const oldRoot = page.overlay.root;
  page.mount();
  page.refresh();
  assert.equal(oldRoot.isConnected, false);
  assert.equal(page.ports.at(-1).disconnected, true);
  assert.equal(page.requests.length, 3);
  assert.equal(page.overlay.lines.hidden, true);
});

test("retains the source and retries busy once with no repeated provider calls on failure", () => {
  const page = browser();
  page.captions(cues);
  page.ports[0].onMessage.emit({ ok: false, error: "busy" });
  page.refresh();
  assert.equal(page.ports.length, 1);
  page.runTimers(800);
  assert.equal(page.ports.length, 2);
  page.ports[1].onMessage.emit({ ok: false, error: "busy" });
  page.runTimers(800);
  page.refresh();
  assert.equal(page.ports.length, 2);
  assert.equal(page.overlay.original.textContent, "Sentence 1");
  assert.equal(page.overlay.status.textContent, "Chinese translation unavailable.");
});

test("keeps captions as text and rejects any partial or mismatched batch", () => {
  const page = browser();
  const text = "<img src=x onerror=alert(1)>";
  page.captions([{ start: 0, end: 15, text }, { start: 2, end: 4, text: "Overlap" }]);
  assert.equal(page.overlay.original.textContent, text);
  assert.equal(page.overlay.original.children.length, 0);
  page.playAt(3);
  assert.equal(page.overlay.original.textContent, "Overlap");
  page.playAt(5);
  assert.equal(page.overlay.original.textContent, text);
  page.ports[0].onMessage.emit({ ok: true, translations: [{ id: 1, text: "第一句" }, { id: 1, text: "不匹配" }] });
  page.refresh();
  assert.equal(page.overlay.translation.textContent, "");
  assert.equal(page.ports.length, 1);
});
