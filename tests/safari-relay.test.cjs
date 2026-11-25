const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:net');
const { join, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { after, test } = require('node:test');

const tool = 'com.nelson007.online-subtitle';
const safari = 'com.nelson007.online-subtitle.safari';
const source = resolve(__dirname, '../BrowserCompanions/Safari');
let build;
let executable;

function relayExecutable() {
  if (executable) return executable;
  build = mkdtempSync('/tmp/mhs-build-');
  const runner = join(build, 'main.swift');
  writeFileSync(runner, `
import Foundation
let args = CommandLine.arguments
let group = URL(fileURLWithPath: args[2], isDirectory: true)
let bundleIdentifier = "${safari}"
do {
    if args[1] == "server" {
        try SafariCompanionRelayServer(groupDirectory: group, extensionBundleIdentifier: bundleIdentifier).serve()
    } else {
        let frame = try JSONSerialization.jsonObject(with: Data(args[3].utf8)) as! [String: Any]
        let deadline = DispatchTime.now() + .milliseconds(Int(args[4])!)
        let reply = try SafariCompanionRelayClient(groupDirectory: group).request(frame, before: deadline)
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: reply))
    }
} catch {
    let reply = ((error as? CompanionBridgeFailure) ?? .unavailable).response
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: reply))
}
`);
  executable = join(build, 'relay');
  execFileSync('swiftc', ['-D', 'MACHELPER_COMPANION_TESTING', runner,
    join(source, 'CompanionBrokerClient.swift'), join(source, 'SafariCompanionRelay.swift'), '-o', executable],
    { timeout: 30_000 });
  return executable;
}

after(() => {
  if (build) rmSync(build, { recursive: true, force: true });
});

function fixtureDirectory(t) {
  const directory = mkdtempSync('/tmp/mhs-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function until(condition, description) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await delay(20);
  }
  assert.fail(description);
}

async function setup(t, receive) {
  const broker = fixtureDirectory(t);
  const name = '0123456789abcdef0123456789abcdef.sock';
  const connections = new Set();
  const socketServer = createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    let input = Buffer.alloc(0);
    function handle(chunk) {
      input = Buffer.concat([input, chunk]);
      if (input.length < 4 || input.length < 4 + input.readUInt32LE()) return;
      socket.removeListener('data', handle);
      receive(JSON.parse(input.subarray(4)), socket);
    }
    socket.on('data', handle);
  });
  socketServer.listen(join(broker, name));
  await once(socketServer, 'listening');
  t.after(() => {
    for (const socket of connections) socket.destroy();
    return new Promise((done) => socketServer.close(done));
  });
  writeFileSync(join(broker, 'endpoint'), name, { mode: 0o600 });
  const group = fixtureDirectory(t);
  const server = spawn(relayExecutable(), ['server', group], {
    env: { ...process.env, MACHELPER_COMPANION_TEST_DIRECTORY: broker }
  });
  t.after(async () => {
    if (server.exitCode !== null || server.signalCode !== null) return;
    const stopped = once(server, 'close');
    server.kill();
    await stopped;
  });
  const directory = join(group, 'OnlineSubtitleRelay');
  await until(() => existsSync(join(directory, 'server')), 'Safari relay did not start');
  return { group, directory };
}

function call(group, message, milliseconds = 2_000) {
  const child = spawn(relayExecutable(), ['client', group, JSON.stringify(message), String(milliseconds)]);
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk));
  return once(child, 'close').then(([status]) => {
    assert.equal(status, 0);
    return JSON.parse(Buffer.concat(output));
  });
}

function reply(socket, message) {
  const bytes = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(bytes.length);
  socket.end(Buffer.concat([header, bytes]));
}

test('Safari App Group relay sends one exact tool request and cleans the mailbox', { timeout: 10_000 }, async (t) => {
  const requests = [];
  const { group, directory } = await setup(t, (request, socket) => {
    requests.push(request);
    reply(socket, request.type === 'watchStatus' ? { type: 'status', enabled: true } : { ok: true, payload: 'opaque reply' });
  });
  assert.deepEqual(await call(group, { type: 'getStatus', extension: tool }), { type: 'status', enabled: true });
  const invoke = { type: 'invoke', extension: tool, command: 'caption-settings', payload: 'opaque request' };
  assert.deepEqual(await call(group, invoke), { ok: true, payload: 'opaque reply' });
  assert.deepEqual(await call(group, { ...invoke, extension: 'com.example.other' }), { ok: false, error: 'invalid' });
  assert.deepEqual(requests, [
    { type: 'watchStatus', extension: tool, browser: 'safari', companion: safari },
    { ...invoke, browser: 'safari', companion: safari }
  ]);
  assert.deepEqual(readdirSync(directory), ['server']);
});

test('Safari client expiry cancels the pending broker invocation', { timeout: 10_000 }, async (t) => {
  let cancelled = false;
  let received = false;
  const { group, directory } = await setup(t, (_, socket) => {
    received = true;
    socket.once('end', () => { cancelled = true; socket.end(); });
  });
  const invoke = { type: 'invoke', extension: tool, command: 'caption-settings', payload: '{}' };
  assert.deepEqual(await call(group, invoke, 400), { ok: false, error: 'unavailable' });
  assert.ok(received);
  await until(() => cancelled, 'broker did not receive EOF after Safari client expired');
  assert.deepEqual(readdirSync(directory), ['server']);
});

test('Safari relay rejects a symlink substituted for its private group directory', { timeout: 10_000 }, async (t) => {
  const group = fixtureDirectory(t);
  const unrelated = fixtureDirectory(t);
  symlinkSync(unrelated, join(group, 'OnlineSubtitleRelay'));
  assert.deepEqual(await call(group, { type: 'getStatus', extension: tool }), { ok: false, error: 'unavailable' });
  assert.deepEqual(readdirSync(unrelated), []);
});
