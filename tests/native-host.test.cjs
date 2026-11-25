const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:net');
const { join, resolve } = require('node:path');
const { after, before, test } = require('node:test');

const companion = 'ndmbmmhddeibbojclldpaabmkcielfmj';
const extension = 'com.nelson007.online-subtitle';
const origin = `chrome-extension://${companion}/`;
const request = { type: 'translate', cues: [{ id: 12, text: 'A short example.' }] };
const sentenceRequest = { ...request, type: 'translateSentences' };
const response = { ok: true, translations: [{ id: 12, text: '一个简短的例子。' }] };
const settingsRequest = { type: 'getSettings' };
const wordRequest = { type: 'explainWord', word: 'café', sentence: 'The café is open.' };
const configuration = { targetLanguage: 'fr', revision: 'ac'.repeat(32) };
const explanation = { meaning: 'Un établissement de restauration.', sentenceMeaning: 'Le café est ouvert.' };
const statusRequest = { type: 'watchStatus' };
const statusSubscription = { ...statusRequest, extension, companion };
let directory;
let bridge;

before(() => {
  directory = mkdtempSync('/tmp/online-subtitle-bridge-');
  bridge = join(directory, 'bridge');
  execFileSync('/usr/bin/xcrun', ['swiftc', '-D', 'ONLINE_SUBTITLE_BRIDGE_TEST',
    resolve(__dirname, '../NativeHost/main.swift'), '-o', bridge]);
});

after(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function unframe(bytes) {
  assert.ok(bytes.length > 4);
  assert.equal(bytes.readUInt32LE(), bytes.length - 4);
  return JSON.parse(bytes.subarray(4));
}

function commandRequest(message, command) {
  const { payload, ...envelope } = message;
  assert.deepEqual(envelope, { type: 'invoke', extension, companion, command });
  assert.equal(typeof payload, 'string');
  return JSON.parse(payload);
}

function captionRequest(message) {
  return commandRequest(message, 'translate-captions');
}

function commandReply(reply) {
  return { ok: true, payload: JSON.stringify(reply) };
}

function launch(t, socketDirectory, browserOrigin = origin) {
  const host = spawn(bridge, [browserOrigin], {
    env: { ...process.env, ONLINE_SUBTITLE_BRIDGE_TEST_DIRECTORY: socketDirectory },
  });
  const stdout = [];
  host.stdout.on('data', (chunk) => stdout.push(chunk));
  host.stdin.on('error', (error) => { if (error.code !== 'EPIPE') throw error; });
  t.after(() => host.kill());
  const result = once(host, 'close').then(([code]) => {
    assert.equal(code, 0);
    return Buffer.concat(stdout);
  });
  return { host, result };
}

async function openWorker(t, onRequest) {
  const socketDirectory = mkdtempSync(join(directory, 'worker-'));
  const name = '0123456789abcdef0123456789abcdef.sock';
  const sockets = new Set();
  const worker = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let bytes = Buffer.alloc(0);
    function receive(chunk) {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 4 || bytes.length < bytes.readUInt32LE() + 4) return;
      socket.removeListener('data', receive);
      onRequest(unframe(bytes), socket);
    }
    socket.on('data', receive);
  });
  worker.listen(join(socketDirectory, name));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    worker.close();
  });
  await once(worker, 'listening');
  writeFileSync(join(socketDirectory, 'endpoint'), name, { mode: 0o600 });
  return socketDirectory;
}

test('native host serves only the registered Chrome extension', { timeout: 8000 }, async (t) => {
  const { result } = launch(t, directory, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/');
  assert.equal((await result).length, 0);
});

test('native host rejects unrelated, oversized, and duplicate cue requests', { timeout: 8000 }, async (t) => {
  for (const bytes of [frame({ type: 'other', cues: request.cues }),
    frame({ ...request, settings: {} }), frame({ ...request, cues: [request.cues[0], request.cues[0]] }),
    frame({ ...sentenceRequest, cues: [{ ...request.cues[0], source: 'Do not forward.' }] }),
    frame({ ...statusRequest, cues: request.cues }),
    frame({ ...settingsRequest, command: 'invoke' }),
    frame({ ...wordRequest, targetLanguage: 'en' }),
    frame({ ...wordRequest, word: 'cafe\u0301' }),
    frame({ ...wordRequest, word: '茶'.repeat(86), sentence: '茶'.repeat(86) }),
    frame({ ...wordRequest, sentence: 'café' + '茶'.repeat(666) }),
    frame({ ...wordRequest, word: 'café\u0007', sentence: 'café\u0007' }),
    Buffer.from([1, 128, 0, 0])]) {
    const { host, result } = launch(t, directory);
    host.stdin.write(bytes);
    assert.deepEqual(unframe(await result), { ok: false, error: 'invalid' });
  }
});

test('native host reports an unavailable MacHelper companion service', { timeout: 8000 }, async (t) => {
  const { host, result } = launch(t, directory);
  host.stdin.write(frame(request));
  assert.deepEqual(unframe(await result), { ok: false, error: 'unavailable' });
});

test('native host round trips a fragmented caption request and response', { timeout: 8000 }, async (t) => {
  const socketDirectory = await openWorker(t, (message, socket) => {
    assert.deepEqual(captionRequest(message), request);
    const bytes = frame(commandReply(response));
    socket.write(bytes.subarray(0, 2));
    setTimeout(() => socket.end(bytes.subarray(2)), 10);
  });
  const { host, result } = launch(t, socketDirectory);
  const bytes = frame(request);
  host.stdin.write(bytes.subarray(0, 6));
  setTimeout(() => host.stdin.write(bytes.subarray(6)), 10);
  assert.deepEqual(unframe(await result), response);
});

test('native host forwards sentence requests and only valid optional source text', { timeout: 8000 }, async (t) => {
  const sources = ['字'.repeat(333) + 'a', '字'.repeat(334), 17, 'A\u0007B', undefined];
  const request = { ...sentenceRequest, cues: sources.map((_, i) => ({ id: i + 1, text: 'A sentence.' })) };
  const rows = sources.map((source, i) => ({ id: i + 1, text: '一句话。', source }));
  const directory = await openWorker(t, (message, socket) => {
    assert.deepEqual(captionRequest(message), request);
    socket.end(frame(commandReply({ ok: true, translations: rows })));
  });
  const { host, result } = launch(t, directory);
  host.stdin.write(frame(request));
  assert.deepEqual(unframe(await result), {
    ok: true, translations: [rows[0], ...rows.slice(1).map(({ id, text }) => ({ id, text }))],
  });
});

test('native host preserves the legacy response shape and forwards unsupported sentence errors', { timeout: 8000 }, async (t) => {
  const compatibilityError = { ok: false, error: 'invalid' };
  const provided = { ok: true, translations: [{ ...response.translations[0], source: 'A cleaned example.' }] };
  const directory = await openWorker(t, (message, socket) => {
    socket.end(frame(captionRequest(message).type === 'translate' ? commandReply(provided) : compatibilityError));
  });
  for (const [input, expected] of [[request, response], [sentenceRequest, compatibilityError]]) {
    const { host, result } = launch(t, directory);
    host.stdin.write(frame(input));
    assert.deepEqual(unframe(await result), expected);
  }
});

test('native host invokes only the matching approved settings or word command', { timeout: 8000 }, async (t) => {
  const longLookup = {...wordRequest, sentence: 'café' + '茶'.repeat(665)};
  for (const [request, command, result] of [
    [settingsRequest, 'caption-settings', configuration],
    [longLookup, 'explain-word', { ...configuration, ...explanation }],
  ]) {
    const reply = { ok: true, ...result };
    const socketDirectory = await openWorker(t, (message, socket) => {
      assert.deepEqual(commandRequest(message, command), request);
      socket.end(frame(commandReply(reply)));
    });
    const { host, result: bytes } = launch(t, socketDirectory);
    host.stdin.write(frame(request));
    assert.deepEqual(unframe(await bytes), reply);
  }
});

test('native host validates reply metadata and both parts of each word explanation', { timeout: 8000 }, async (t) => {
  const settings = { ok: true, ...configuration };
  const lookup = { ...settings, ...explanation };
  for (const [request, command, reply] of [
    [settingsRequest, 'caption-settings', { ...settings, prompt: 'Sensitive user prompt.' }],
    [settingsRequest, 'caption-settings', { ...settings, targetLanguage: 'en-US' }],
    [settingsRequest, 'caption-settings', { ...settings, revision: 'a'.repeat(64) + '\n' }],
    [wordRequest, 'explain-word', { ...lookup, sentenceMeaning: null }],
    [wordRequest, 'explain-word', { ...lookup, meaning: '茶'.repeat(667) }],
    [wordRequest, 'explain-word', { ...lookup, sentenceMeaning: 'a\u007f' }],
    [sentenceRequest, 'translate-captions', { ...response, targetLanguage: 'fr' }],
  ]) {
    const socketDirectory = await openWorker(t, (message, socket) => {
      assert.deepEqual(commandRequest(message, command), request);
      socket.end(frame(commandReply(reply)));
    });
    const { host, result } = launch(t, socketDirectory);
    host.stdin.write(frame(request));
    assert.deepEqual(unframe(await result), { ok: false, error: 'unavailable' });
  }
});

test('native host passes validated settings metadata with caption batches', { timeout: 8000 }, async (t) => {
  const reply = { ...response, ...configuration };
  const directory = await openWorker(t, (message, socket) => {
    assert.deepEqual(captionRequest(message), sentenceRequest);
    socket.end(frame(commandReply(reply)));
  });
  const { host, result } = launch(t, directory);
  host.stdin.write(frame(sentenceRequest));
  assert.deepEqual(unframe(await result), reply);
});

test('native host allows broker escaping overhead while preserving the browser frame limit', { timeout: 8000 }, async (t) => {
  const cues = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, text: 'Original.' }));
  const translations = cues.map(({ id }) => ({ id, text: '\\'.repeat(1_400) }));
  const request = { type: 'translateSentences', cues };
  const response = { ok: true, translations };
  assert.ok(frame(response).length < 32 * 1024);
  assert.ok(frame(commandReply(response)).length > 32 * 1024);
  const directory = await openWorker(t, (message, socket) => {
    assert.deepEqual(captionRequest(message), request);
    socket.end(frame(commandReply(response)));
  });
  const { host, result } = launch(t, directory);
  host.stdin.write(frame(request));
  assert.deepEqual(unframe(await result), response);
});

test('native host maps broker failure and retains worker errors', { timeout: 8000 }, async (t) => {
  const examples = [
    [{ ok: false, error: 'failed' }, 'translation'],
    [{ ok: false, error: 'busy' }, 'busy'],
    [commandReply({ ok: false, error: 'model' }), 'model'],
    [{ ok: true, payload: 'not JSON' }, 'unavailable'],
  ];
  for (const [reply, error] of examples) {
    const directory = await openWorker(t, (message, socket) => {
      assert.deepEqual(captionRequest(message), sentenceRequest);
      socket.end(frame(reply));
    });
    const { host, result } = launch(t, directory);
    host.stdin.write(frame(sentenceRequest));
    assert.deepEqual(unframe(await result), { ok: false, error });
  }
});

test('native host cancels word lookup transport when Chrome disconnects', { timeout: 8000 }, async (t) => {
  let browser;
  let cancelled;
  const cancellation = new Promise((resolve) => { cancelled = resolve; });
  const socketDirectory = await openWorker(t, (message, socket) => {
    assert.deepEqual(commandRequest(message, 'explain-word'), wordRequest);
    socket.once('end', cancelled);
    browser.host.stdin.end();
  });
  browser = launch(t, socketDirectory);
  browser.host.stdin.write(frame(wordRequest));
  const [result] = await Promise.all([browser.result, cancellation]);
  assert.equal(result.length, 0);
});

test('native host relays successive status frames and disconnects when Chrome closes', { timeout: 8000 }, async (t) => {
  let macHelper;
  let disconnected;
  const connectionEnded = new Promise((resolve) => { disconnected = resolve; });
  const enabled = frame({ type: 'status', enabled: true });
  const disabled = frame({ type: 'status', enabled: false });
  const socketDirectory = await openWorker(t, (message, socket) => {
    assert.deepEqual(message, statusSubscription);
    macHelper = socket;
    socket.once('end', disconnected);
    socket.write(enabled.subarray(0, 2));
    setTimeout(() => socket.write(enabled.subarray(2)), 10);
  });
  const { host, result } = launch(t, socketDirectory);
  host.stdin.write(frame(statusRequest));
  await once(host.stdout, 'data');
  const update = once(host.stdout, 'data');
  macHelper.write(disabled);
  await update;
  host.stdin.end();
  const [bytes] = await Promise.all([result, connectionEnded]);
  assert.deepEqual(unframe(bytes.subarray(0, enabled.length)), { type: 'status', enabled: true });
  assert.deepEqual(unframe(bytes.subarray(enabled.length)), { type: 'status', enabled: false });
});

test('native status relay closes without forwarding malformed or oversized updates', { timeout: 8000 }, async (t) => {
  for (const payload of [frame({ type: 'status', enabled: 1 }),
    frame({ type: 'status', enabled: true, unexpected: true }), Buffer.from([1, 4, 0, 0])]) {
    const socketDirectory = await openWorker(t, (message, socket) => {
      assert.deepEqual(message, statusSubscription);
      socket.end(payload);
    });
    const { host, result } = launch(t, socketDirectory);
    host.stdin.write(frame(statusRequest));
    assert.equal((await result).length, 0);
  }
});
