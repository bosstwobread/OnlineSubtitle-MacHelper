const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const script = readFileSync(require.resolve("../Chrome/subtitle-interactions.js"), "utf8");

class Element {
  className = "";
  hidden = false;
  children = [];
  attributes = new Map();
  properties = new Map();
  handlers = new Map();
  pointers = new Set();
  style = { setProperty: (name, value) => this.properties.set(name, value) };
  text = "";

  constructor(tagName, focus) {
    this.tagName = tagName;
    this.focus = () => focus(this);
  }

  get isConnected() {
    return this.anchored || this.parent?.isConnected === true;
  }

  get textContent() {
    return this.text + this.children.map(child => child.textContent).join("");
  }

  set textContent(value) {
    this.replaceChildren();
    this.text = value;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node.tagName === "#fragment") {
        this.append(...node.children);
      } else {
        node.remove();
        node.parent = this;
        this.children.push(node);
      }
    }
  }

  replaceChildren(...nodes) {
    for (const node of [...this.children]) node.remove();
    this.text = "";
    this.append(...nodes);
  }

  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = undefined;
  }

  addEventListener(type, listener) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.handlers.get(type).delete(listener);
  }

  emit(type, properties = {}) {
    const event = {
      isTrusted: true,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...properties
    };
    for (const listener of this.handlers.get(type) ?? []) listener(event);
    return event;
  }

  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  setPointerCapture(id) { this.pointers.add(id); }
  hasPointerCapture(id) { return this.pointers.has(id); }
  releasePointerCapture(id) { this.pointers.delete(id); }
}

function environment() {
  const calls = [];
  const wordSides = [];
  const observers = new Set();
  let focused;
  const make = tag => new Element(tag, element => { focused = element; });
  const window = make("window");
  const scope = vm.createContext({
    window,
    document: {
      createElement: make,
      createDocumentFragment: () => make("#fragment"),
      createTextNode(text) { return Object.assign(make("#text"), {text}); }
    },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(node) { node.observed = true; observers.add(this.callback); }
      disconnect() { observers.delete(this.callback); }
    }
  });
  vm.runInContext(script, scope);

  return {
    calls,
    wordSides,
    window,
    get focused() { return focused; },
    resize() { for (const callback of observers) callback(); },
    mount({withTranslation = false} = {}) {
      const player = make("div");
      player.anchored = true;
      const root = make("div");
      const stack = make("div");
      const original = make("div");
      const translated = withTranslation ? make("div") : undefined;
      player.append(root);
      root.append(stack);
      stack.append(original);
      if (translated) stack.append(translated);
      root.clientHeight = 600;
      root.getBoundingClientRect = () => ({top: 100, bottom: 100 + root.clientHeight});
      stack.offsetHeight = 80;
      const bottom = () => parseFloat(stack.properties.get("--online-subtitle-bottom") ?? "90px");
      stack.getBoundingClientRect = () => ({bottom: root.getBoundingClientRect().bottom - bottom(),
        top: root.getBoundingClientRect().bottom - bottom() - stack.offsetHeight});
      const interaction = scope.onlineSubtitleCreateInteractions({player, root, stack, original, translated,
        onWord(word, side) { calls.push(word); wordSides.push(side); interaction.showLookup(word); },
        onDismiss() { calls.push("dismissed"); },
        message: key => key});
      const panel = root.children[1];
      return {interaction, player, root, stack, original, translated, handle: stack.children.at(-1), panel,
        heading: panel.children[0].children[0], close: panel.children[0].children[1],
        status: panel.children[1], result: panel.children[2], bottom};
    }
  };
}

function renderedWords(line) {
  return line.children.flatMap(node => node.tagName === "button" ? [node] : renderedWords(node));
}

test("word buttons preserve captions, segment multilingual words, and require trusted activation", () => {
  const page = environment();
  const {interaction, original, stack, close, heading} = page.mount();
  interaction.renderSource("We'll say ‘go!’ <img>", "en");
  assert.equal(original.textContent, "We'll say ‘go!’ <img>");
  assert.deepEqual(renderedWords(original).map(node => node.textContent),
    ["We'll", "say", "go", "img"]);
  assert.ok(original.children.every(node => ["button", "span", "#text"].includes(node.tagName)));
  const first = original.children[0];
  interaction.renderSource("We'll say ‘go!’ <img>", "en");
  assert.equal(first, original.children[0]);
  assert.equal(first.emit("click", {isTrusted: false}).propagationStopped, true);
  stack.hidden = true;
  first.emit("click");
  assert.deepEqual(page.calls, []);
  stack.hidden = false;
  first.emit("click");
  assert.deepEqual(page.calls, ["We'll"]);
  assert.deepEqual(page.wordSides, ["original"]);
  assert.equal(page.focused, close);
  assert.equal(heading.lang, "en");

  interaction.renderSource("你好，世界！", "zh-Hans");
  assert.equal(original.textContent, "你好，世界！");
  assert.deepEqual(renderedWords(original).map(node => node.textContent),
    ["你好", "世界"]);
  interaction.renderSource("A word.", "invalid code");
  assert.equal(original.textContent, "A word.");
});

test("translated words activate the translation row and retain its spoken language", () => {
  const page = environment();
  const {interaction, translated, heading} = page.mount({withTranslation: true});
  interaction.renderSource("Hello, world!", "en");
  interaction.renderTranslation("你好，世界！", "zh-CN");
  assert.equal(translated.textContent, "你好，世界！");
  const first = renderedWords(translated)[0];
  first.emit("click", {isTrusted: false});
  assert.deepEqual(page.calls, []);
  first.emit("click");
  assert.deepEqual(page.calls, ["你好"]);
  assert.deepEqual(page.wordSides, ["translation"]);
  assert.equal(heading.lang, "zh-CN");
  assert.equal(heading.textContent, "你好");
});

test("closing punctuation stays with its word across wrapping and is excluded from lookups", () => {
  const page = environment();
  const {interaction, original, translated} = page.mount({withTranslation: true});
  interaction.renderSource("Go, then “wait!”", "en");
  interaction.renderTranslation("你好，世界！", "zh-CN");
  assert.equal(original.textContent, "Go, then “wait!”");
  assert.equal(translated.textContent, "你好，世界！");
  const comma = original.children[0];
  assert.equal(comma.className, "online-subtitle-word-group");
  assert.equal(comma.textContent, "Go,");
  assert.equal(comma.children[1].tagName, "#text");
  assert.equal(original.children.at(-1).textContent, "wait!”");
  assert.equal(translated.children.at(-1).textContent, "世界！");
  comma.children[0].emit("click");
  assert.deepEqual(page.calls, ["Go"]);
  assert.deepEqual(page.wordSides, ["original"]);
});

test("lookup panel presents plain-text results, fallback, and accessible dismissal", () => {
  const page = environment();
  const {interaction, root, original, panel, heading, close, status, result} = page.mount();
  assert.equal(panel.attributes.get("role"), "dialog");
  assert.equal(panel.attributes.get("aria-label"), "wordLookupTitle");
  assert.equal(close.attributes.get("aria-label"), "closeWordLookup");
  assert.equal(panel.hidden, true);

  interaction.renderSource("A word.", "en");
  const word = renderedWords(original)[1];
  word.emit("click");
  assert.equal(heading.textContent, "word");
  assert.equal(panel.hidden, false);
  assert.equal(panel.attributes.get("data-online-subtitle-placement"), "above");
  assert.equal(status.textContent, "wordLookupLoading");
  assert.equal(status.hidden, false);
  assert.equal(result.hidden, true);
  interaction.completeLookup({meaning: "<strong>un mot</strong>", sentenceMeaning: "Un mot.", targetLanguage: "fr"});
  assert.deepEqual(result.children.map(node => node.textContent), ["wordMeaning", "<strong>un mot</strong>", "sentenceMeaning", "Un mot."]);
  assert.equal(result.children[1].lang, "fr");
  assert.equal(result.children[3].lang, "fr");
  assert.equal(result.hidden, false);
  assert.equal(status.hidden, true);
  close.emit("click", {isTrusted: false});
  assert.equal(panel.hidden, false);
  assert.equal(root.emit("keydown", {key: "Escape"}).defaultPrevented, true);
  assert.deepEqual(page.calls, ["word", "dismissed"]);
  assert.equal(page.focused, word);
  assert.equal(panel.hidden, true);
  assert.equal(result.children[1].textContent, "");
  interaction.completeLookup({meaning: "Late", sentenceMeaning: "Stale", targetLanguage: "en"});
  assert.equal(result.children[1].textContent, "");

  interaction.showLookup("another");
  interaction.failLookup();
  assert.equal(status.textContent, "wordLookupUnavailable");
  assert.equal(result.hidden, true);
  interaction.closeLookup();
  assert.equal(panel.hidden, true);
  assert.deepEqual(page.calls, ["word", "dismissed"]);
});

test("vertical drag captures only the initiating pointer, clamps, and survives resized or remounted players", () => {
  const page = environment();
  const {interaction, root, stack, panel, handle, bottom} = page.mount();
  const pointer = {pointerId: 42, isPrimary: true, button: 0, clientY: 300};
  handle.emit("pointerdown", {...pointer, isTrusted: false});
  assert.equal(handle.pointers.size, 0);
  assert.equal(handle.emit("pointerdown", pointer).defaultPrevented, true);
  assert.equal(handle.pointers.has(42), true);
  assert.ok(handle.attributes.has("data-online-subtitle-dragging"));
  handle.emit("pointermove", {pointerId: 43, clientY: 100});
  handle.emit("pointermove", {pointerId: 42, clientY: Infinity});
  handle.emit("pointermove", {pointerId: 42, clientY: 100, isTrusted: false});
  assert.equal(bottom(), 90);
  handle.emit("pointermove", {pointerId: 42, clientY: 250, clientX: 1_000});
  assert.equal(bottom(), 140);
  assert.deepEqual([...stack.properties.keys()], ["--online-subtitle-bottom"]);

  handle.emit("pointermove", {pointerId: 42, clientY: -1_000});
  assert.equal(bottom(), 496);
  interaction.showLookup("word");
  assert.equal(panel.attributes.get("data-online-subtitle-placement"), "below");
  handle.emit("pointerup", {pointerId: 42});
  assert.ok(handle.pointers.has(42)); // Chrome releases capture after pointerup.
  handle.releasePointerCapture(42);
  handle.emit("lostpointercapture", {pointerId: 42});
  assert.equal(handle.pointers.size, 0);
  assert.equal(handle.attributes.has("data-online-subtitle-dragging"), false);
  handle.emit("pointermove", {pointerId: 42, clientY: 800});
  assert.equal(bottom(), 496);

  root.clientHeight = 260;
  page.resize();
  assert.equal(bottom(), 156);
  assert.equal(handle.emit("keydown", {key: "ArrowDown"}).defaultPrevented, true);
  assert.equal(bottom(), 144);
  handle.emit("pointerdown", pointer);
  handle.emit("pointermove", {pointerId: 42, clientY: 2_000});
  assert.equal(bottom(), 44.2);
  interaction.destroy();
  assert.equal(handle.pointers.size, 0);
  assert.equal(panel.isConnected, false);
  assert.equal(handle.isConnected, false);

  const next = page.mount();
  page.resize();
  assert.equal(next.bottom(), 68);
  assert.ok(next.player.observed);
});

test("the grip isolates compatibility mouse actions from the player", () => {
  const page = environment();
  const {interaction, handle, player} = page.mount();
  for (const type of ["mousedown", "mouseup", "click", "dblclick"]) {
    const event = page.window.emit(type, {composedPath: () => [handle, player]});
    assert.equal(event.propagationStopped, true);
    assert.equal(event.defaultPrevented, true);
  }
  const outside = page.window.emit("click", {composedPath: () => [player]});
  assert.equal(outside.propagationStopped, undefined);
  assert.equal(handle.emit("keydown", {key: " "}).propagationStopped, true);
  interaction.destroy();
  assert.equal(page.window.emit("click", {composedPath: () => [handle, player]}).propagationStopped, undefined);
});
