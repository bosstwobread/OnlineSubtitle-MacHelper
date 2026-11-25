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
      type,
      target: this,
      isTrusted: true,
      composedPath: () => this.path(),
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...properties
    };
    for (const listener of this.handlers.get(type) ?? []) listener(event);
    return event;
  }

  path() { return [this, ...(this.parent?.path() ?? [])]; }

  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  setPointerCapture(id) { this.pointers.add(id); }
  hasPointerCapture(id) { return this.pointers.has(id); }
  releasePointerCapture(id) { this.pointers.delete(id); }
}

function environment() {
  const calls = [];
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
    window,
    gesture(type, element, properties = {}) {
      return window.emit(type, {target: element, composedPath: () => element.path(), ...properties});
    },
    click(element, properties) { return this.gesture("click", element, properties); },
    get focused() { return focused; },
    resize() { for (const callback of observers) callback(); },
    mount() {
      const player = make("div");
      player.anchored = true;
      const root = make("div");
      const stack = make("div");
      const original = make("div");
      const translated = make("div");
      player.append(root);
      root.append(stack);
      stack.append(original, translated);
      root.clientHeight = 600;
      root.getBoundingClientRect = () => ({top: 100, bottom: 100 + root.clientHeight});
      stack.offsetHeight = 80;
      const bottom = () => parseFloat(stack.properties.get("--online-subtitle-bottom") ?? "90px");
      stack.getBoundingClientRect = () => ({bottom: root.getBoundingClientRect().bottom - bottom(),
        top: root.getBoundingClientRect().bottom - bottom() - stack.offsetHeight});
      const interaction = scope.onlineSubtitleCreateInteractions({player, root, stack, original,
        onWord(word) { calls.push(word); interaction.showLookup(word); },
        onDismiss() { calls.push("dismissed"); },
        message: key => key});
      const panel = root.children[1];
      return {interaction, player, root, stack, original, translated, panel,
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
  assert.equal(page.click(first, {isTrusted: false}).propagationStopped, true);
  stack.hidden = true;
  page.click(first);
  assert.deepEqual(page.calls, []);
  stack.hidden = false;
  page.click(first);
  assert.deepEqual(page.calls, ["We'll"]);
  assert.equal(page.focused, close);
  assert.equal(heading.lang, "en");

  interaction.renderSource("你好，世界！", "zh-Hans");
  assert.equal(original.textContent, "你好，世界！");
  assert.deepEqual(renderedWords(original).map(node => node.textContent),
    ["你好", "世界"]);
  interaction.renderSource("今日は晴れです。", "ja");
  assert.ok(renderedWords(original).some(node => node.textContent === "晴れ"));
  interaction.renderSource("ما معنى الكلمة؟", "ar");
  assert.equal(original.textContent, "ما معنى الكلمة؟");
  assert.deepEqual(renderedWords(original).map(node => node.textContent), ["ما", "معنى", "الكلمة"]);
  page.click(renderedWords(original).at(-1));
  assert.equal(heading.lang, "ar");
  assert.equal(heading.dir, "auto");
  assert.deepEqual(page.calls, ["We'll", "الكلمة"]);
  interaction.renderSource("A word.", "invalid code");
  assert.equal(original.textContent, "A word.");
});

test("translated text and caption background drag, while original word buttons are excluded", () => {
  const page = environment();
  const {interaction, original, translated, stack, panel, bottom} = page.mount();
  interaction.renderSource("Hello, world!", "en");
  translated.textContent = "你好，世界！";
  assert.equal(translated.textContent, "你好，世界！");
  assert.equal(renderedWords(translated).length, 0);
  assert.equal(stack.children.length, 2);
  assert.equal(stack.tabIndex, 0);
  assert.equal(stack.attributes.get("aria-label"), "moveSubtitles");
  page.click(translated);
  assert.deepEqual(page.calls, []);

  const word = renderedWords(original)[0];
  const pointer = {pointerId: 24, isPrimary: true, button: 0, clientY: 300};
  assert.equal(page.gesture("pointerdown", word, pointer).defaultPrevented, undefined);
  assert.equal(stack.pointers.size, 0);
  assert.equal(stack.emit("keydown", {key: "ArrowUp", target: word}).defaultPrevented, undefined);
  assert.equal(page.gesture("pointerdown", panel, pointer).propagationStopped, undefined);
  assert.equal(stack.pointers.size, 0);

  assert.equal(page.gesture("pointerdown", translated, pointer).defaultPrevented, true);
  assert.ok(stack.pointers.has(24));
  assert.equal(page.focused, stack);
  page.gesture("pointermove", stack, {pointerId: 24, clientY: 250});
  assert.equal(bottom(), 140);
  interaction.destroy();
});

test("closing punctuation stays with its word across wrapping and is excluded from lookups", () => {
  const page = environment();
  const {interaction, original} = page.mount();
  interaction.renderSource("Go, then “wait!”", "en");
  assert.equal(original.textContent, "Go, then “wait!”");
  const comma = original.children[0];
  assert.equal(comma.className, "online-subtitle-word-group");
  assert.equal(comma.textContent, "Go,");
  assert.equal(comma.children[1].tagName, "#text");
  assert.equal(original.children.at(-1).textContent, "wait!”");
  page.click(comma.children[0]);
  assert.deepEqual(page.calls, ["Go"]);
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
  page.click(word);
  assert.equal(heading.textContent, "word");
  assert.equal(panel.hidden, false);
  assert.equal(panel.attributes.get("data-online-subtitle-placement"), "above");
  assert.equal(status.textContent, "wordLookupLoading");
  assert.equal(status.hidden, false);
  assert.equal(result.hidden, true);
  interaction.completeLookup({meaning: "<strong>un mot</strong>", targetLanguage: "fr"});
  assert.equal(result.textContent, "<strong>un mot</strong>");
  assert.equal(result.children.length, 0);
  assert.equal(result.lang, "fr");
  assert.equal(result.hidden, false);
  assert.equal(status.hidden, true);
  close.emit("click", {isTrusted: false});
  assert.equal(panel.hidden, false);
  assert.equal(root.emit("keydown", {key: "Escape"}).defaultPrevented, true);
  assert.deepEqual(page.calls, ["word", "dismissed"]);
  assert.equal(page.focused, word);
  assert.equal(panel.hidden, true);
  assert.equal(result.textContent, "");
  interaction.completeLookup({meaning: "Late", targetLanguage: "en"});
  assert.equal(result.textContent, "");

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
  const {interaction, player, root, stack, panel, bottom} = page.mount();
  const pointer = {pointerId: 42, isPrimary: true, button: 0, clientY: 300};
  page.gesture("pointerdown", stack, {...pointer, isTrusted: false});
  assert.equal(stack.pointers.size, 0);
  assert.equal(page.gesture("pointerdown", player, pointer).propagationStopped, undefined);
  const start = page.gesture("pointerdown", stack, pointer);
  assert.equal(start.defaultPrevented, true);
  assert.equal(start.propagationStopped, true);
  assert.equal(stack.pointers.has(42), true);
  assert.ok(stack.attributes.has("data-online-subtitle-dragging"));
  assert.equal(page.gesture("pointermove", player, {pointerId: 43, clientY: 100}).propagationStopped, undefined);
  page.gesture("pointermove", stack, {pointerId: 42, clientY: Infinity});
  page.gesture("pointermove", stack, {pointerId: 42, clientY: 100, isTrusted: false});
  assert.equal(bottom(), 90);
  assert.equal(page.gesture("pointermove", player, {pointerId: 42, clientY: 250, clientX: 1_000}).propagationStopped, true);
  assert.equal(bottom(), 140);
  assert.deepEqual([...stack.properties.keys()], ["--online-subtitle-bottom"]);

  page.gesture("pointermove", stack, {pointerId: 42, clientY: -1_000});
  assert.equal(bottom(), 510);
  interaction.showLookup("word");
  assert.equal(panel.attributes.get("data-online-subtitle-placement"), "below");
  assert.equal(page.gesture("pointerup", player, {pointerId: 42}).propagationStopped, true);
  assert.ok(stack.pointers.has(42)); // Chrome releases capture after pointerup.
  stack.releasePointerCapture(42);
  page.gesture("lostpointercapture", stack, {pointerId: 42});
  assert.equal(stack.pointers.size, 0);
  assert.equal(stack.attributes.has("data-online-subtitle-dragging"), false);
  assert.equal(page.gesture("pointermove", player, {pointerId: 42, clientY: 800}).propagationStopped, undefined);
  assert.equal(bottom(), 510);

  root.clientHeight = 260;
  page.resize();
  assert.equal(bottom(), 170);
  assert.equal(stack.emit("keydown", {key: "ArrowDown"}).defaultPrevented, true);
  assert.equal(bottom(), 158);
  page.gesture("pointerdown", stack, pointer);
  page.gesture("pointermove", stack, {pointerId: 42, clientY: 2_000});
  assert.equal(bottom(), 44.2);
  interaction.destroy();
  assert.equal(stack.pointers.size, 0);
  assert.equal(panel.isConnected, false);

  const next = page.mount();
  page.resize();
  assert.equal(next.bottom(), 68);
  assert.ok(next.player.observed);
});

test("caption interactions isolate compatibility mouse actions from the player", () => {
  const page = environment();
  const {interaction, original, stack, player} = page.mount();
  for (const type of ["mousedown", "mouseup", "click", "dblclick"]) {
    const event = page.window.emit(type, {composedPath: () => stack.path()});
    assert.equal(event.propagationStopped, true);
    assert.equal(event.defaultPrevented, true);
  }
  const outside = page.window.emit("click", {composedPath: () => [player]});
  assert.equal(outside.propagationStopped, undefined);
  assert.equal(stack.emit("keydown", {key: " "}).propagationStopped, true);
  interaction.renderSource("Lookup.", "en");
  assert.equal(page.click(renderedWords(original)[0]).propagationStopped, true);
  assert.deepEqual(page.calls, ["Lookup"]);
  interaction.destroy();
  assert.equal(page.click(stack).propagationStopped, undefined);
});
