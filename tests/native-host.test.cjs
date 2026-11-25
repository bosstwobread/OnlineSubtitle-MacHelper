const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:net');
const { join, resolve } = require('node:path');
const { after, before, test } = require('node:test');

const origin = 'chrome-extension://ndmbmmhddeibbojclldpaabmkcielfmj/';
const request = { type: 'translate', cues: [{ id: 12, text: 'A short example.' }] };
const response = { ok: true, translations: [{ id: 12, text: '一个简短的例子。' }] };
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
    Buffer.from([1, 128, 0, 0])]) {
    const { host, result } = launch(t, directory);
    host.stdin.write(bytes);
    assert.deepEqual(unframe(await result), { ok: false, error: 'invalid' });
  }
});

test('native host reports an unavailable MacHelper worker', { timeout: 8000 }, async (t) => {
  const { host, result } = launch(t, directory);
  host.stdin.write(frame(request));
  assert.deepEqual(unframe(await result), { ok: false, error: 'unavailable' });
});

test('native host round trips a fragmented caption request and response', { timeout: 8000 }, async (t) => {
  const socketDirectory = await openWorker(t, (message, socket) => {
    assert.deepEqual(message, request);
    const bytes = frame(response);
    socket.write(bytes.subarray(0, 2));
    setTimeout(() => socket.end(bytes.subarray(2)), 10);
  });
  const { host, result } = launch(t, socketDirectory);
  const bytes = frame(request);
  host.stdin.write(bytes.subarray(0, 6));
  setTimeout(() => host.stdin.write(bytes.subarray(6)), 10);
  assert.deepEqual(unframe(await result), response);
});

test('native host cancels worker transport when Chrome disconnects', { timeout: 8000 }, async (t) => {
  let browser;
  let cancelled;
  const cancellation = new Promise((resolve) => { cancelled = resolve; });
  const socketDirectory = await openWorker(t, (message, socket) => {
    assert.deepEqual(message, request);
    socket.once('end', cancelled);
    browser.host.stdin.end();
  });
  browser = launch(t, socketDirectory);
  browser.host.stdin.write(frame(request));
  const [result] = await Promise.all([browser.result, cancellation]);
  assert.equal(result.length, 0);
});
