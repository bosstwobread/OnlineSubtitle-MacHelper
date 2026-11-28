const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const source = readFileSync(resolve(__dirname, '../Chrome/background.js'), 'utf8');
const managedSource = readFileSync(resolve(__dirname, '../BrowserCompanions/managed-transport.js'), 'utf8');
const origin = 'https://www.youtube.com';
const netflixOrigin = 'https://www.netflix.com';
const extensionID = 'ndmbmmhddeibbojclldpaabmkcielfmj';
const sender = { id: extensionID, frameId: 0, origin, tab: { id: 1 }, url: origin + '/watch?v=abcdefghijk' };
const netflixSender = { ...sender, origin: netflixOrigin, url: netflixOrigin + '/watch/81234567?trackId=1' };
const request = { type: 'watchStatus' };
const enabled = { type: 'status', enabled: true };
const settingsRequest = { type: 'getSettings' };
const wordRequest = { type: 'explainWord', word: 'café', sentence: 'The café is open.' };
const configuration = { targetLanguage: 'fr', revision: 'ac'.repeat(32) };
const explanation = { meaning: 'Un établissement de restauration.' };

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

function loadBackground({ managed = false, sendNativeMessage, netflix = !sendNativeMessage } = {}) {
  const nativePorts = [];
  const timers = new Map();
  let lastTimer = 0;
  const runtime = {
    id: extensionID,
    onConnect: event(),
    getManifest() {
      return { content_scripts: [{ matches: [(netflix ? netflixOrigin : origin) + '/*'] }] };
    },
    connectNative(host) {
      assert.equal(host, managed ? 'com.localaibasetools.companion' : 'com.nelson007.online_subtitle');
      const port = makePort(host);
      nativePorts.push(port);
      return port;
    },
  };
  const sandbox = { chrome: { runtime }, TextEncoder, URL };
  if (sendNativeMessage) {
    sandbox.onlineSubtitleSafari = true;
    sandbox.browser = { runtime: { sendNativeMessage } };
    sandbox.setTimeout = (callback, delay) => {
      assert.equal(delay, 4000);
      timers.set(++lastTimer, callback);
      return lastTimer;
    };
    sandbox.clearTimeout = timer => timers.delete(timer);
  }
  runInNewContext(managed ? managedSource + '\n' + source : source, sandbox);
  return {
    nativePorts, timers,
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

test('command bridge forwards settings and word lookups on a single connection each', () => {
  const background = loadBackground();
  const longLookup = {...wordRequest, sentence: 'café' + '茶'.repeat(665)};
  const lookupResult = { ...configuration, ...explanation };
  for (const [request, result, expected] of [
    [settingsRequest, configuration, configuration],
    [longLookup, lookupResult, lookupResult],
    [wordRequest, { ...lookupResult, sentenceMeaning: 'Le café est ouvert.' }, lookupResult],
  ]) {
    const browser = background.connect(sender, 'online-subtitle-translate');
    browser.onMessage.emit(request);
    const native = background.nativePorts.at(-1);
    assert.deepEqual(native.messages, [request]);
    native.onMessage.emit({ ok: true, ...result });
    assert.deepEqual(browser.messages, [{ ok: true, ...expected }]);
    assert.equal(browser.disconnected, true);
    assert.equal(native.disconnected, true);
  }
  assert.equal(background.nativePorts.length, 3);
});

test('command bridge rejects out-of-scope word, settings and command data before opening any native connection', () => {
  const background = loadBackground();
  const invalid = [
    { ...settingsRequest, command: 'invoke' },
    { ...wordRequest, model: 'other' },
    { ...wordRequest, word: 'cafe\u0301' },
    { ...wordRequest, sentence: '茶'.repeat(666) + 'café' },
    { ...wordRequest, word: '茶'.repeat(86), sentence: '茶'.repeat(86) },
    { ...wordRequest, word: '\u0007' },
    { ...wordRequest, sentence: 'café\u007f' },
    { type: 'invoke', command: 'caption-settings' },
  ];
  for (const input of invalid) {
    const browser = background.connect(sender, 'online-subtitle-translate');
    browser.onMessage.emit(input);
    assert.deepEqual(browser.messages, [{ ok: false, error: 'invalid' }]);
    assert.equal(browser.disconnected, true);
  }
  assert.equal(background.nativePorts.length, 0);
});

test('command bridge rejects malformed reply metadata or an incomplete word explanation', () => {
  const response = { ok: true, ...configuration };
  const translated = [{ id: 1, text: 'Une phrase.' }];
  const translation = { type: 'translate', cues: [{ id: 1, text: 'A sentence.' }] };
  const background = loadBackground();
  for (const [request, reply] of [
    [settingsRequest, { ...response, targetLanguage: 'en-US' }],
    [settingsRequest, { ...response, revision: response.revision.toUpperCase() }],
    [settingsRequest, { ...response, revision: response.revision + '\n' }],
    [settingsRequest, { ...response, prompt: 'Do not expose prompt data.' }],
    [wordRequest, response],
    [wordRequest, { ...response, ...explanation, meaning: '\u0007bad' }],
    [wordRequest, { ...response, ...explanation, sentenceMeaning: '茶'.repeat(667) }],
    [wordRequest, { ...response, ...explanation, sentenceMeaning: null }],
    [translation, { ok: true, translations: translated, targetLanguage: 'fr' }],
  ]) {
    const browser = background.connect(sender, 'online-subtitle-translate');
    browser.onMessage.emit(request);
    background.nativePorts.at(-1).onMessage.emit(reply);
    assert.deepEqual(browser.messages, [{ ok: false, error: 'translation' }]);
  }
  const browser = background.connect(sender, 'online-subtitle-translate');
  browser.onMessage.emit(translation);
  background.nativePorts.at(-1).onMessage.emit({ ...response, translations: translated });
  assert.deepEqual(browser.messages, [{ ...response, translations: translated }]);
});

test('command bridge cancels a word lookup if its content connection closes', () => {
  const background = loadBackground();
  const browser = background.connect(sender, 'online-subtitle-translate');
  browser.onMessage.emit(wordRequest);
  const [native] = background.nativePorts;
  browser.onDisconnect.emit();
  assert.equal(native.disconnected, true);
  native.onMessage.emit({ ok: true, ...configuration, ...explanation });
  assert.deepEqual(browser.messages, []);
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

test('Netflix watch pages reach the approved Chrome or Edge bridge', () => {
  for (const managed of [false, true]) {
    const background = loadBackground({ managed });
    const browser = background.connect(netflixSender, 'online-subtitle-translate');
    assert.equal(browser.disconnected, false);
    browser.onMessage.emit(settingsRequest);
    const [native] = background.nativePorts;
    assert.deepEqual(native.messages, [managed ? {
      type: 'invoke', extension: 'com.nelson007.online-subtitle',
      command: 'caption-settings', payload: JSON.stringify(settingsRequest),
    } : settingsRequest]);
  }
});

test('Netflix routing requires the declared site and an exact top-level watch page', () => {
  const background = loadBackground({ managed: true });
  for (const from of [
    { ...netflixSender, frameId: 1 }, { ...netflixSender, tab: undefined }, { ...netflixSender, id: 'other' },
    { ...netflixSender, origin }, { ...netflixSender, url: 'https://netflix.com/watch/123' },
    { ...netflixSender, url: 'http://www.netflix.com/watch/123' },
    { ...netflixSender, url: 'https://www.netflix.com.example/watch/123' },
    ...['/browse', '/watch', '/watch/title', '/watch/123/', '/watch/123/extra'].map(path =>
      ({ ...netflixSender, url: netflixOrigin + path })),
  ]) {
    assert.equal(background.connect(from).disconnected, true, JSON.stringify(from));
  }
  assert.equal(background.nativePorts.length, 0);

  const youtubeOnly = loadBackground({ managed: true, netflix: false });
  assert.equal(youtubeOnly.connect(netflixSender).disconnected, true);
  assert.equal(youtubeOnly.connect().disconnected, false);
  assert.equal(youtubeOnly.nativePorts.length, 0);
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


test('managed companion wraps approved command and status messages without changing the caption response', () => {
  const background = loadBackground({ managed: true });
  const extension = 'com.nelson007.online-subtitle';
  const status = background.connect();
  status.onMessage.emit(request);
  const [watcher] = background.nativePorts;
  assert.deepEqual(watcher.messages, [{ type: 'watchStatus', extension }]);
  watcher.onMessage.emit(enabled);
  assert.deepEqual(status.messages, [enabled]);

  const commands = [
    [settingsRequest, 'caption-settings', configuration],
    [wordRequest, 'explain-word', { ...configuration, ...explanation }],
    [{ type: 'translateSentences', cues: [{ id: 1, text: 'A sentence.' }] }, 'translate-captions',
      { ...configuration, translations: [{ id: 1, text: 'Une phrase.' }] }],
  ];
  for (const [request, command, result] of commands) {
    const page = background.connect(sender, 'online-subtitle-translate');
    page.onMessage.emit(request);
    const native = background.nativePorts.at(-1);
    assert.deepEqual(native.messages, [{ type: 'invoke', extension, command, payload: JSON.stringify(request) }]);
    native.onMessage.emit({ ok: true, payload: JSON.stringify({ ok: true, ...result }) });
    assert.deepEqual(page.messages, [{ ok: true, ...result }]);
    assert.equal(native.disconnected, true);
  }
  const page = background.connect(sender, 'online-subtitle-translate');
  page.onMessage.emit(settingsRequest);
  background.nativePorts.at(-1).onMessage.emit({ ok: false, error: 'failed' });
  assert.deepEqual(page.messages, [{ ok: false, error: 'translation' }]);
});

test('Safari polls one valid status at a time and stops on disconnect', async () => {
  const requests = [];
  const background = loadBackground({
    managed: true,
    sendNativeMessage(host, message) {
      assert.equal(host, 'com.localaibasetools.companion');
      requests.push(JSON.parse(JSON.stringify(message)));
      return Promise.resolve(requests.length === 1 ? enabled : { ...enabled, enabled: false });
    },
  });
  const status = background.connect();
  status.onMessage.emit(request);
  await new Promise(setImmediate);
  assert.deepEqual(requests, [{ type: 'getStatus', extension: 'com.nelson007.online-subtitle' }]);
  assert.deepEqual(status.messages, [enabled]);
  assert.equal(background.timers.size, 1);
  const [timer, poll] = background.timers.entries().next().value;
  background.timers.delete(timer);
  poll();
  await new Promise(setImmediate);
  assert.deepEqual(status.messages, [enabled, { ...enabled, enabled: false }]);
  assert.equal(background.timers.size, 1);
  status.onDisconnect.emit();
  assert.equal(background.timers.size, 0);
  assert.equal(background.nativePorts.length, 0);
});

test('Safari discards a late command response when the content port closes', async () => {
  let respond;
  const background = loadBackground({
    managed: true,
    sendNativeMessage(host, message) {
      assert.equal(host, 'com.localaibasetools.companion');
      assert.equal(message.command, 'explain-word');
      return new Promise(resolve => { respond = resolve; });
    },
  });
  const page = background.connect(sender, 'online-subtitle-translate');
  page.onMessage.emit(wordRequest);
  page.onDisconnect.emit();
  respond({ ok: true, payload: JSON.stringify({ ok: true, ...configuration, ...explanation }) });
  await new Promise(setImmediate);
  assert.deepEqual(page.messages, []);
});
