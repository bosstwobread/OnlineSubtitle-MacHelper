const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { content_scripts: scripts } = require("../Chrome/manifest.json");
const script = scripts.find(({ js }) => js.includes("content.js")).js
  .filter(name => name !== "subtitle-interactions.js")
  .map(name => readFileSync(path.join(__dirname, "../Chrome", name), "utf8")).join("\n");
const videoId = "AbCdeFghI-1";
const otherVideoId = "123456789ab";
const defaultSettings = { ok: true, targetLanguage: "zh-CN", revision: "a".repeat(64) };

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

function browser({ id = videoId, currentTime = 0, hidden = false, enabled = true, adClass, timestamp = "",
  settings = defaultSettings } = {}) {
  const location = { origin: "https://www.youtube.com", pathname: "/watch", search: `?v=${id}${timestamp}` };
  const document = new EventTarget();
  const window = new EventTarget();
  const requests = [];
  const cancelledRequests = [];
  const ports = [];
  const statusPorts = [];
  const settingsPorts = [];
  const lookupPorts = [];
  const observers = [];
  const microtasks = [];
  const timers = new Map();
  const intervals = new Map();
  let timerId = 0;
  let now = Date.now();
  let player;
  let video;
  let interaction;
  let pauses = 0;

  function mount(time = currentTime) {
    if (player) player.isConnected = false;
    if (video) video.isConnected = false;
    player = new Element();
    video = Object.assign(new Element(), { isVideo: true, currentTime: time, HAVE_METADATA: 1, readyState: 1, seeking: false });
    video.pause = () => { pauses++; video.dispatchEvent(new Event("pause")); };
    if (adClass) player.classList.add(adClass);
    player.append(video);
  }

  mount();
  document.hidden = hidden;
  document.createElement = () => new Element();
  document.getElementById = name => name === "movie_player" ? player : null;
  document.addEventListener("online-subtitle-request-captions", event => requests.push(event.detail));
  document.addEventListener("online-subtitle-cancel-captions", event => cancelledRequests.push(event.detail));
  window.top = window;
  vm.runInNewContext(script, {
    chrome: { runtime: {
      connect(options) {
        const status = options.name === "online-subtitle-status";
        if (!status) assert.equal(options.name, "online-subtitle-translate");
        const port = {
          disconnected: false,
          onDisconnect: signal(),
          onMessage: signal(),
          disconnect() {
            if (this.disconnected) return;
            this.disconnected = true;
            this.onDisconnect.emit();
          },
          postMessage(message) {
            this.sent = structuredClone(message);
            if (status) {
              if (enabled !== null) this.onMessage.emit({ type: "status", enabled });
            } else if (message.type === "getSettings") {
              settingsPorts.push(this);
              if (settings !== null) this.onMessage.emit(settings);
            } else {
              (message.type === "explainWord" ? lookupPorts : ports).push(this);
            }
          }
        };
        if (status) statusPorts.push(port);
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
    Date: class extends Date { static now() { return now; } },
    onlineSubtitleCreateInteractions({ original, onWord, onDismiss }) {
      interaction = {
        onWord, onDismiss,
        view: undefined,
        renderSource(text) { original.textContent = text; },
        showLookup(word) { this.view = { word }; },
        completeLookup(reply) { this.view = { ...this.view, ...structuredClone(reply) }; },
        failLookup() { this.view = { ...this.view, failed: true }; },
        closeLookup() { this.view = undefined; },
        destroy() {}
      };
      return interaction;
    },
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
    document, window, location, requests, cancelledRequests, ports, statusPorts, mount, settingsPorts, lookupPorts,
    get lookup() { return interaction.view; },
    get pauses() { return pauses; },
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
    status(enabled, port = statusPorts.at(-1)) {
      port.onMessage.emit({ type: "status", enabled });
    },
    playAt(time, event = "timeupdate") {
      video.currentTime = time;
      video.dispatchEvent(new Event(event));
    },
    clickWord(word) { interaction.onWord(word); },
    dismissLookup() { interaction.onDismiss(); },
    focus(nextSettings = settings) {
      settings = nextSettings;
      window.dispatchEvent(new Event("focus"));
    },
    ad(active, className = adClass ?? "ad-showing") {
      if (active) player.classList.add(className);
      else player.classList.delete(className);
      for (const observer of observers) observer();
    },
    refresh() { for (const interval of intervals.values()) interval(); },
    advance(milliseconds) { now += milliseconds; this.refresh(); },
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

function assertNoOverlay(page) {
  assert.equal(page.overlay.lines.hidden, true);
  assert.equal(page.overlay.original.textContent, "");
  assert.equal(page.overlay.translation.textContent, "");
}

function assertNativeCaptionsAvailable(page) {
  assertNoOverlay(page);
  assert.equal(page.player.attributes.has("data-online-subtitle-visible"), false);
}

function assertWaitingForPair(page) {
  assertNoOverlay(page);
  assert.equal(page.player.attributes.has("data-online-subtitle-visible"), true);
}

test("reads the target before translating and refreshes paired captions after a settings change", () => {
  const page = browser({ currentTime: 1, settings: null });
  page.captions([{ start: 0, end: 3, text: "Carry on." }]);
  assert.deepEqual(page.settingsPorts[0].sent, { type: "getSettings" });
  assert.equal(page.ports.length, 0);
  assertWaitingForPair(page);
  const french = { ok: true, targetLanguage: "fr", revision: "f".repeat(64) };
  page.settingsPorts[0].onMessage.emit(french);
  page.ports[0].onMessage.emit({ ...french, translations: [{ id: 1, text: "Continue." }] });
  page.runMicrotasks();
  assert.equal(page.overlay.translation.lang, "fr");
  assert.equal(page.overlay.translation.textContent, "Continue.");

  const german = { ok: true, targetLanguage: "de", revision: "d".repeat(64) };
  page.focus(german);
  assertWaitingForPair(page);
  assert.equal(page.overlay.translation.lang, "de");
  assert.equal(page.ports.length, 2);
  page.ports[1].onMessage.emit({ ...german, translations: [{ id: 1, text: "Mach weiter." }] });
  assert.equal(page.overlay.translation.textContent, "Mach weiter.");
});

test("original words use the whole caption as context and show only the contextual meaning", () => {
  const page = browser({ currentTime: 1 });
  page.captions([{ start: 0, end: 5, text: "The bank groaned." }]);
  page.ports[0].onMessage.emit({
    ...defaultSettings, translations: [{ id: 1, source: "The bank closed.", text: "银行关门了。" }]
  });
  page.clickWord("groaned");
  assert.equal(page.overlay.translation.textContent, "银行关门了。");
  assert.equal(page.overlay.translation.children.length, 0);
  page.clickWord("银行");
  assert.equal(page.lookupPorts.length, 0);
  page.clickWord("bank");
  assert.equal(page.pauses, 1);
  assert.deepEqual(page.lookupPorts[0].sent, { type: "explainWord", word: "bank", sentence: "The bank closed." });
  assert.deepEqual(page.lookup, { word: "bank" });
  page.lookupPorts[0].onMessage.emit({ ...defaultSettings, meaning: "银行" });
  assert.deepEqual(page.lookup, {
    word: "bank", meaning: "银行", targetLanguage: "zh-CN"
  });
  page.dismissLookup();
  assert.equal(page.lookup, undefined);
});

test("non-English originals get synchronized translations and contextual word lookups", () => {
  const settings = { ok: true, targetLanguage: "en", revision: "e".repeat(64) };
  const page = browser({ currentTime: 1, settings });
  const source = "ما معنى هذه الكلمة؟";
  page.captions([
    { start: 0, end: 1, text: "ما معنى" }, { start: 1, end: 3, text: "هذه الكلمة؟" }
  ], { sourceLanguage: "ar" });
  assert.deepEqual(page.ports[0].sent, { type: "translateSentences", cues: [{ id: 1, text: source }] });
  page.ports[0].onMessage.emit({
    ...settings, translations: [{ id: 1, text: "What does this word mean?" }]
  });
  assert.equal(page.overlay.original.textContent, source);
  assert.equal(page.overlay.original.lang, "ar");
  assert.equal(page.overlay.original.dir, "auto");
  assert.equal(page.overlay.translation.textContent, "What does this word mean?");
  page.clickWord("الكلمة");
  assert.deepEqual(page.lookupPorts[0].sent, { type: "explainWord", word: "الكلمة", sentence: source });
  page.lookupPorts[0].onMessage.emit({ ...settings, meaning: "The word." });
  assert.deepEqual(page.lookup, { word: "الكلمة", meaning: "The word.", targetLanguage: "en" });
});

test("a visible tab picks up the next worker settings generation after a transient disconnect", () => {
  const page = browser({ currentTime: 1 });
  page.captions([{ start: 0, end: 5, text: "The bank closed." }]);
  page.ports[0].onMessage.emit({ ok: false, error: "unavailable" });
  assertNativeCaptionsAvailable(page);
  const german = { ok: true, targetLanguage: "de", revision: "d".repeat(64) };
  page.focus({ ok: false, error: "busy" });
  assert.equal(page.ports.length, 1);
  page.focus(null);
  page.settingsPorts.at(-1).onMessage.emit({ ok: false, error: "busy" });
  page.advance(8_000);
  page.settingsPorts.at(-1).onMessage.emit(german);
  assert.equal(page.ports.length, 2);
  page.ports[1].onMessage.emit({ ...german, translations: [{ id: 1, text: "Die Bank schloss." }] });
  assert.equal(page.overlay.translation.textContent, "Die Bank schloss.");
  assert.equal(page.overlay.status.hidden, true);
});

test("a seek cancels an in-flight word lookup and ignores its late result", () => {
  const page = browser({ currentTime: 1 });
  page.captions([{ start: 0, end: 5, text: "The bank closed." }]);
  translate([], page.ports[0]);
  page.clickWord("bank");
  const pending = page.lookupPorts[0];
  assert.equal(pending.disconnected, false);
  page.playAt(6, "seeking");
  assert.equal(pending.disconnected, true);
  pending.onMessage.emit({ ...defaultSettings, meaning: "银行" });
  assert.equal(page.lookup, undefined);
});

test("waits for MacHelper to confirm the watch session before loading captions", () => {
  const page = browser({ enabled: null });
  page.refresh();
  assert.equal(page.statusPorts.length, 1);
  assert.deepEqual(page.statusPorts[0].sent, { type: "watchStatus" });
  assert.equal(page.requests.length, 0);
  assert.equal(page.overlay.root, undefined);
  page.status(false);
  page.runTimers(5_000);
  page.refresh();
  assert.equal(page.statusPorts.length, 1);
  assert.equal(page.requests.length, 0);
  assert.equal(page.ports.length, 0);
  page.status(true);
  assert.ok(page.overlay.root);
  assertNativeCaptionsAvailable(page);
  assert.equal(page.requests.length, 1);
  page.status(true);
  assert.equal(page.requests.length, 1);
});

test("disabling removes the overlay and native-caption styling and cancels translation", () => {
  const page = browser();
  const ccButton = new Element();
  ccButton.setAttribute("aria-pressed", "true");
  page.player.append(ccButton);
  page.captions(cues);
  translate([], page.ports[0]);
  page.runMicrotasks();
  const oldRoot = page.overlay.root;
  const oldPort = page.ports[1];
  assert.equal(page.player.attributes.has("data-online-subtitle-visible"), true);
  page.status(false);
  assert.equal(oldRoot.isConnected, false);
  assert.equal(page.overlay.root, undefined);
  assert.equal(page.player.attributes.has("data-online-subtitle-visible"), false);
  assert.equal(ccButton.attributes.get("aria-pressed"), "true");
  assert.equal(oldPort.disconnected, true);
  translate([], oldPort);
  page.playAt(6);
  page.refresh();
  assert.equal(page.ports.length, 2);
  assert.equal(page.requests.length, 1);
  assert.equal(page.overlay.root, undefined);

  page.status(true);
  assert.equal(page.statusPorts.length, 1);
  assert.equal(page.requests.length, 2);
  page.captions(cues);
  assertWaitingForPair(page);
  assert.equal(page.ports.length, 3);
});

test("disabling sends an exact caption cancellation and discards late replies after re-enable", () => {
  const page = browser();
  const oldRequest = page.requests[0];
  page.status(false);
  assert.deepEqual(page.cancelledRequests, [oldRequest]);
  page.captions(cues, { request: oldRequest });
  assert.equal(page.ports.length, 0);

  page.status(true);
  assert.notEqual(page.requests[1].id, oldRequest.id);
  page.captions(cues, { request: oldRequest });
  assert.equal(page.overlay.lines.hidden, true);
  assert.equal(page.ports.length, 0);
  page.captions([{ start: 0, end: 4, text: "Fresh caption" }]);
  assertWaitingForPair(page);
  assert.equal(page.ports.length, 1);
  translate([], page.ports[0]);
  assert.equal(page.overlay.original.textContent, "Fresh caption");
});

test("malformed status and disconnect tear down the overlay and use a fresh connection", () => {
  const page = browser({ enabled: null });
  const first = page.statusPorts[0];
  page.status(true);
  page.captions(cues);
  page.status("true");
  assert.equal(first.disconnected, true);
  assert.equal(page.overlay.root, undefined);
  assert.equal(page.player.attributes.has("data-online-subtitle-visible"), false);
  assert.equal(page.ports[0].disconnected, true);
  page.status(true, first);
  page.refresh();
  assert.equal(page.statusPorts.length, 1);
  assert.equal(page.overlay.root, undefined);
  page.runTimers(500);
  assert.equal(page.statusPorts.length, 2);
  const second = page.statusPorts[1];
  page.status(true);
  assert.ok(page.overlay.root);
  second.disconnect();
  assert.equal(page.overlay.root, undefined);
  page.runTimers(500);
  assert.equal(page.statusPorts.length, 3);
  page.status(true, second);
  assert.equal(page.overlay.root, undefined);
  page.status(true);
  assert.ok(page.overlay.root);
  assert.equal(page.requests.length, 3);
});

test("unanswered status requests back off and pagehide removes the retry", () => {
  const page = browser({ enabled: null });
  page.runTimers(5_000);
  assert.equal(page.statusPorts[0].disconnected, true);
  page.runTimers(500);
  assert.equal(page.statusPorts.length, 2);
  page.runTimers(5_000);
  page.runTimers(500);
  assert.equal(page.statusPorts.length, 2);
  page.runTimers(1_000);
  assert.equal(page.statusPorts.length, 3);
  page.runTimers(5_000);
  page.window.dispatchEvent(new Event("pagehide"));
  page.runTimers(2_000);
  page.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(page.statusPorts.length, 3);
  page.window.dispatchEvent(new Event("pageshow"));
  assert.equal(page.statusPorts.length, 4);
  assert.equal(page.requests.length, 0);
});

test("shows both languages together, translates the playhead first, then covers every cue", () => {
  const page = browser({ currentTime: 32 });
  assert.equal(page.requests.length, 1);
  page.captions(cues);
  assertWaitingForPair(page);
  assert.deepEqual(page.ports[0].sent, { type: "translateSentences", cues: [7, 8, 9].map(id => ({ id, text: `Sentence ${id}` })) });

  const batches = [];
  for (const port of page.ports) {
    translate(batches, port);
    page.runMicrotasks();
  }
  assert.equal(page.overlay.lines.hidden, false);
  assert.equal(page.overlay.original.textContent, "Sentence 7");
  assert.equal(page.overlay.translation.textContent, "第7句");
  assert.equal(page.player.attributes.has("data-online-subtitle-visible"), true);
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
  assertWaitingForPair(page);
});

test("translates opening captions during preroll with YouTube captions unsuppressed", () => {
  const page = browser({ currentTime: 64, adClass: "ad-showing", enabled: null });
  assert.equal(page.requests.length, 0);
  page.status(true);
  assert.equal(page.requests.length, 1);
  page.captions(cues);
  const opening = page.ports[0];
  assert.deepEqual(opening.sent.cues.map(cue => cue.id), [1, 2, 3]);
  page.playAt(61, "seeked");
  assert.equal(opening.disconnected, false);
  translate([], opening);
  page.runMicrotasks();
  const next = page.ports[1];
  assert.deepEqual(next.sent.cues.map(cue => cue.id), [4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(page.overlay.lines.hidden, true);
  assert.equal(page.overlay.translation.textContent, "");
  assert.equal(page.player.attributes.has("data-online-subtitle-visible"), false);

  page.video.currentTime = 1;
  page.ad(false);
  assert.equal(page.requests.length, 1);
  assert.equal(next.disconnected, false);
  assert.equal(page.overlay.original.textContent, "Sentence 1");
  assert.equal(page.overlay.translation.textContent, "第1句");
  assert.equal(page.player.attributes.has("data-online-subtitle-visible"), true);
});

test("uses a linked starting point during an ad and reprioritizes a different content resume", () => {
  const page = browser({ adClass: "ad-interrupting", timestamp: "&t=1m2s" });
  page.captions(cues);
  const opening = page.ports[0];
  assert.deepEqual(opening.sent.cues.map(cue => cue.id), [1, 13, 14]);
  page.playAt(43, "seeked");
  assert.equal(opening.disconnected, false);
  assert.equal(page.overlay.lines.hidden, true);

  page.video.currentTime = 31;
  page.ad(false);
  assert.equal(opening.disconnected, true);
  assert.deepEqual(page.ports[1].sent.cues.map(cue => cue.id), [7, 8, 9]);
  assertWaitingForPair(page);
});

test("keeps the opening batch when the ad class clears before the video clock resets", () => {
  const page = browser({ currentTime: 62, adClass: "ad-showing" });
  page.captions(cues);
  const opening = page.ports[0];
  page.ad(false);
  page.refresh();
  assert.equal(opening.disconnected, false);
  assert.equal(page.overlay.lines.hidden, true);
  translate([], opening);
  assert.equal(page.overlay.lines.hidden, true);
  page.playAt(1, "loadedmetadata");
  assert.equal(page.overlay.original.textContent, "Sentence 1");
  assert.equal(page.overlay.translation.textContent, "第1句");
});

test("preserves a translation across a midroll and keeps the main playhead as the priority", () => {
  const page = browser({ currentTime: 31 });
  page.captions(cues);
  const current = page.ports[0];
  assert.deepEqual(current.sent.cues.map(cue => cue.id), [7, 8, 9]);
  page.ad(true, "ad-interrupting");
  page.playAt(1, "seeked");
  assert.equal(current.disconnected, false);
  translate([], current);
  page.runMicrotasks();
  assert.deepEqual(page.ports[1].sent.cues.map(cue => cue.id), [1, 2, 3, 4, 5, 10, 11, 12]);
  assert.equal(page.overlay.lines.hidden, true);
  page.video.currentTime = 32;
  page.ad(false, "ad-interrupting");
  assert.equal(page.overlay.translation.textContent, "第7句");
});

test("retries once after a preroll where the main captions were unavailable", () => {
  const page = browser({ adClass: "ad-showing" });
  const first = page.requests[0];
  page.captions([], { error: "captions-unavailable" });
  assert.equal(page.overlay.status.hidden, true);
  page.refresh();
  assert.equal(page.requests.length, 1);
  page.ad(false);
  assert.equal(page.requests.length, 2);
  page.playAt(0, "loadedmetadata");
  page.captions(cues, { request: first });
  assert.equal(page.ports.length, 0);
  page.captions([], { error: "captions-unavailable" });
  assert.equal(page.overlay.status.textContent, "Captions unavailable for this video.");
  assertNativeCaptionsAvailable(page);
  page.refresh();
  assert.equal(page.requests.length, 2);
});

test("restores the cached track only after fresh visible status", () => {
  const page = browser({ enabled: null });
  page.status(true);
  page.captions(cues);
  translate([], page.ports[0]);
  assert.equal(page.overlay.translation.textContent, "第1句");
  page.runMicrotasks();
  assert.equal(page.overlay.original.textContent, "Sentence 1");
  page.document.hidden = true;
  page.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(page.overlay.root, undefined);
  assert.equal(page.ports[1].disconnected, true);
  assert.equal(page.statusPorts[0].disconnected, true);
  page.document.hidden = false;
  page.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(page.statusPorts.length, 2);
  assert.equal(page.overlay.root, undefined);
  assert.equal(page.player.attributes.has("data-online-subtitle-visible"), false);
  assert.equal(page.ports.length, 2);
  page.status(true, page.statusPorts[0]);
  assert.equal(page.overlay.root, undefined);
  page.status(true);
  assert.equal(page.overlay.original.textContent, "Sentence 1");
  assert.equal(page.overlay.translation.textContent, "第1句");
  assert.equal(page.requests.length, 1);
  assert.equal(page.ports.length, 3);
  assert.ok(page.ports[2].sent.cues.every(cue => cue.id > 3));
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
  assertWaitingForPair(page);
  const oldRoot = page.overlay.root;
  page.mount();
  page.refresh();
  assert.equal(oldRoot.isConnected, false);
  assert.equal(page.ports.at(-1).disconnected, true);
  assert.equal(page.requests.length, 3);
  assert.equal(page.overlay.lines.hidden, true);
});

test("keeps YouTube captions available and retries busy once with no repeated provider calls on failure", () => {
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
  assertNativeCaptionsAvailable(page);
  assert.equal(page.overlay.status.textContent, "Subtitle translation unavailable.");
});

test("falls back to native captions for an unfinished cue and keeps completed bilingual cues", () => {
  const page = browser();
  page.captions(cues);
  translate([], page.ports[0]);
  page.runMicrotasks();
  page.playAt(16);
  assertWaitingForPair(page);
  page.ports[1].onMessage.emit({ ok: false, error: "translation" });
  assertNativeCaptionsAvailable(page);
  assert.equal(page.overlay.status.textContent, "Subtitle translation unavailable.");
  page.playAt(1);
  assert.equal(page.overlay.original.textContent, "Sentence 1");
  assert.equal(page.overlay.translation.textContent, "第1句");
});

test("keeps bilingual captions as plain text", () => {
  const page = browser();
  const text = "<img src=x onerror=alert(1)>";
  page.captions([{ start: 0, end: 15, text }, { start: 2, end: 4, text: "Overlap" }]);
  assertWaitingForPair(page);
  translate([], page.ports[0]);
  assert.equal(page.overlay.original.textContent, text);
  assert.equal(page.overlay.original.children.length, 0);
  page.playAt(3);
  assert.equal(page.overlay.original.textContent, "Overlap");
  page.playAt(5);
  assert.equal(page.overlay.original.textContent, text);
});

test("rejects partial batches, duplicate IDs, and corrections without Chinese", () => {
  for (const translations of [
    [{ id: 1, text: "第一句" }],
    [{ id: 1, text: "第一句" }, { id: 1, text: "不匹配" }],
    [{ id: 1, source: "Corrected first sentence." }, { id: 2, text: "第二句" }]
  ]) {
    const page = browser();
    page.captions([
      { start: 0, end: 3, text: "First sentence." },
      { start: 4, end: 7, text: "Second sentence." }
    ]);
    page.ports[0].onMessage.emit({ ok: true, translations });
    page.refresh();
    assertNativeCaptionsAvailable(page);
    assert.equal(page.overlay.status.textContent, "Subtitle translation unavailable.");
    assert.equal(page.ports.length, 1);
  }
});

test("shows a complete sentence across cue boundaries and displays a correction with its translation", () => {
  const page = browser();
  page.captions([
    { start: 0, end: 1.5, text: "We need to nip it" },
    { start: 1.55, end: 3, text: "in the butt." },
    { start: 3, end: 4, text: "Let's do it now." }
  ]);
  const sentence = "We need to nip it in the butt.";
  assertWaitingForPair(page);
  const port = page.ports[0];
  assert.deepEqual(port.sent.cues, [{ id: 1, text: sentence }, { id: 2, text: "Let's do it now." }]);
  port.onMessage.emit({ ok: true, translations: [
    { id: 1, text: "我们得把问题扼杀在萌芽状态。", source: "We need to nip it in the bud." },
    { id: 2, text: "我们现在就做吧。" }
  ] });
  for (const time of [0.1, 1.52, 2.9]) {
    page.playAt(time);
    assert.equal(page.overlay.lines.hidden, false);
    assert.equal(page.overlay.original.textContent, "We need to nip it in the bud.");
    assert.equal(page.overlay.translation.textContent, "我们得把问题扼杀在萌芽状态。");
  }
  page.playAt(3);
  assert.equal(page.overlay.original.textContent, "Let's do it now.");
  assert.equal(page.overlay.translation.textContent, "我们现在就做吧。");
});

test("puts the last word on the preceding sentence and removes inline music labels", () => {
  const page = browser({ currentTime: 12 });
  page.captions([
    { start: 0, end: 9.8, text: "Do you ever look at somebody who achieves big goals and you wonder what makes them so special? Well, there's this one psychological trait that every" },
    { start: 9, end: 17.7, text: "single high achieving person shares. And if you develop this trait, it is almost guaranteed that you'll achieve everything you want in your [music]" },
    { start: 17, end: 24.9, text: "life. My name is Olga. I have just recently graduated from the University of Pennsylvania where I studied computation and cognitive science. And" },
    { start: 24, end: 32, text: "the last four years of studying the human mind have taught me [music] that our brains are malleable." }
  ]);
  const sentence = "And if you develop this trait, it is almost guaranteed that you'll achieve everything you want in your life.";
  const port = page.ports[0];
  assertWaitingForPair(page);
  assert.equal(port.sent.cues[0].text, sentence);
  assert.equal(port.sent.cues[1].text, "My name is Olga.");
  assert.ok(port.sent.cues.every(cue => !cue.text.includes("[music]")));
  port.onMessage.emit({ ok: true, translations: port.sent.cues.map(({ id }, index) => ({
    id, text: index === 0 ? "你几乎可以实现人生中想要的一切。 [音乐]" : "我的名字是奥尔加。"
  })) });
  page.playAt(17.08);
  assert.equal(page.overlay.original.textContent, sentence);
  assert.equal(page.overlay.translation.textContent, "你几乎可以实现人生中想要的一切。");
  page.playAt(17.8);
  assert.equal(page.overlay.original.textContent, "My name is Olga.");
  assert.equal(page.overlay.translation.textContent, "我的名字是奥尔加。");
});

test("suppresses a standalone sound cue without requesting a translation or changing YouTube CC", () => {
  const page = browser({ currentTime: 1 });
  const ccButton = new Element();
  ccButton.setAttribute("aria-pressed", "true");
  page.player.append(ccButton);
  page.captions([{ start: 0, end: 2, text: "[Music]" }]);
  assert.equal(page.overlay.lines.hidden, true);
  assert.equal(page.overlay.status.hidden, true);
  assert.equal(page.ports.length, 0);
  assert.equal(page.player.attributes.has("data-online-subtitle-visible"), true);
  page.refresh();
  assert.equal(page.requests.length, 1);
  page.playAt(3);
  assert.equal(page.player.attributes.has("data-online-subtitle-visible"), false);
  page.playAt(1);
  page.status(false);
  assert.equal(page.player.attributes.has("data-online-subtitle-visible"), false);
  assert.equal(ccButton.attributes.get("aria-pressed"), "true");
});

test("sends grouped batches through the legacy route after an older bridge rejects the new request", () => {
  const page = browser();
  page.captions(cues);
  const first = page.ports[0];
  first.onMessage.emit({ ok: false, error: "invalid" });
  page.runMicrotasks();
  const fallback = page.ports[1];
  assert.deepEqual(fallback.sent, { type: "translate", cues: first.sent.cues });
  assertWaitingForPair(page);
  translate([], fallback);
  page.runMicrotasks();
  assert.equal(page.ports[2].sent.type, "translate");
  assert.equal(page.overlay.original.textContent, "Sentence 1");
  assert.equal(page.overlay.translation.textContent, "第1句");
});
