const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const source = readFileSync(resolve(__dirname, '../Chrome/background.js'), 'utf8');
const origin = 'https://www.youtube.com';
const extensionID = 'ndmbmmhddeibbojclldpaabmkcielfmj';
const sender = { id: extensionID, frameId: 0, origin, tab: { id: 1 }, url: origin + '/watch?v=abcdefghijk' };
const request = { type: 'watchStatus' };
const enabled = { type: 'status', enabled: true };

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(value) { for (const listener of listeners) listener(value); },
  };
}

function makePort(name, from) {
  return {
    name, sender: from, messages: [], disconnected: false,
    onMessage: event(), onDisconnect: event(),
    postMessage(value) { this.messages.push(JSON.parse(JSON.stringify(value))); },
    disconnect() { this.disconnected = true; },
  };
}

function loadBackground() {
  const nativePorts = [];
  const runtime = {
    id: extensionID,
    onConnect: event(),
    connectNative(host) {
      assert.equal(host, 'com.nelson007.online_subtitle');
      const port = makePort(host);
      nativePorts.push(port);
      return port;
    },
  };
  runInNewContext(source, { chrome: { runtime }, TextEncoder, URL });
  return {
    nativePorts,
    connect(from = sender, name = 'online-subtitle-status') {
      const port = makePort(name, from);
      runtime.onConnect.emit(port);
      return port;
    },
  };
}

test('translation bridge forwards both request types and retains safe source text for sentences only', () => {
  const background = loadBackground();
  const goodSource = '字'.repeat(333) + 'a';
  const rows = [goodSource, '字'.repeat(334), ' \t ', 'A\u0007B', undefined].map((source, i) => ({
    id: i + 1, text: '一句话。', source,
  }));
  const cues = rows.map(({ id }) => ({ id, text: 'A sentence.' }));
  for (const type of ['translate', 'translateSentences']) {
    const browser = background.connect(sender, 'online-subtitle-translate');
    browser.onMessage.emit({ type, cues: cues.map(cue => ({ ...cue, source: 'Do not forward.' })) });
    const native = background.nativePorts.at(-1);
    assert.deepEqual(native.messages, [{ type, cues }]);
    native.onMessage.emit({ ok: true, translations: rows });
    const expected = rows.map(({ id, text }) => ({ id, text }));
    if (type === 'translateSentences') expected[0].source = goodSource;
    assert.deepEqual(browser.messages, [{ ok: true, translations: expected }]);
  }
});

test('translation bridge passes an explicit invalid sentence response to the caller', () => {
  const background = loadBackground();
  const browser = background.connect(sender, 'online-subtitle-translate');
  browser.onMessage.emit({ type: 'translateSentences', cues: [{ id: 9, text: 'A sentence.' }] });
  const [native] = background.nativePorts;
  native.onMessage.emit({ ok: false, error: 'invalid' });
  assert.deepEqual(browser.messages, [{ ok: false, error: 'invalid' }]);
  assert.equal(browser.disconnected, true);
});

test('status bridge accepts only the current extension on a top-frame YouTube watch page', () => {
  const background = loadBackground();
  for (const from of [{ ...sender, frameId: 1 }, { ...sender, tab: undefined },
    { ...sender, origin: 'https://example.invalid' }, { ...sender, id: 'other' },
    { ...sender, url: origin + '/feed/subscriptions' }]) {
    assert.equal(background.connect(from).disconnected, true);
  }
  assert.equal(background.nativePorts.length, 0);
});

test('status bridge subscribes once and relays successive boolean updates', () => {
  const background = loadBackground();
  const browser = background.connect();
  assert.equal(background.nativePorts.length, 0);
  browser.onMessage.emit(request);
  const [native] = background.nativePorts;
  assert.deepEqual(native.messages, [request]);
  native.onMessage.emit(enabled);
  native.onMessage.emit({ ...enabled, enabled: false });
  assert.deepEqual(browser.messages, [enabled, { ...enabled, enabled: false }]);
  assert.equal(browser.disconnected, false);
  browser.onMessage.emit(request);
  assert.equal(browser.disconnected, true);
  assert.equal(native.disconnected, true);
});

test('status bridge fails closed on invalid messages and propagates EOF', () => {
  const background = loadBackground();
  const invalidBrowser = background.connect();
  invalidBrowser.onMessage.emit({ ...request, extra: true });
  assert.equal(invalidBrowser.disconnected, true);
  assert.equal(background.nativePorts.length, 0);

  for (const update of [{ ...enabled, enabled: 1 }, { ...enabled, extra: true }, { type: 'other', enabled: true }]) {
    const browser = background.connect();
    browser.onMessage.emit(request);
    const native = background.nativePorts.at(-1);
    native.onMessage.emit(update);
    assert.deepEqual(browser.messages, []);
    assert.equal(browser.disconnected, true);
    assert.equal(native.disconnected, true);
  }

  const browser = background.connect();
  browser.onMessage.emit(request);
  const native = background.nativePorts.at(-1);
  native.onMessage.emit(enabled);
  native.onDisconnect.emit();
  assert.equal(browser.disconnected, true);

  const otherBrowser = background.connect();
  otherBrowser.onMessage.emit(request);
  otherBrowser.onDisconnect.emit();
  assert.equal(background.nativePorts.at(-1).disconnected, true);
});
