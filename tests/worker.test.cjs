"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const sdk = path.resolve(process.env.MACHELPER_NATIVE_SDK ??
  path.join(root, "../LocalAIBaseTools/MacHelper/NativeExtensionSDK/MacHelperNativeSDK.swift"));

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function readFrame(stream) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    function cleanup() {
      stream.off("data", receive);
      stream.off("end", end);
      stream.off("error", fail);
    }
    function fail(error) { cleanup(); reject(error); }
    function end() { fail(new Error("Stream closed before a full frame arrived.")); }
    function receive(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4 || buffer.length < buffer.readUInt32LE() + 4) return;
      cleanup();
      try { resolve(JSON.parse(buffer.subarray(4, buffer.readUInt32LE() + 4))); }
      catch (error) { reject(error); }
    }
    stream.on("data", receive).once("end", end).once("error", fail);
  });
}

test("approved worker translates through the native SDK and Unix socket", { timeout: 70_000 }, async t => {
  const build = fs.mkdtempSync(path.join(os.tmpdir(), "online-subtitle-worker-"));
  const id = process.pid.toString(36);
  const userTemp = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
  const directory = path.join(userTemp, "os-test-" + id);
  t.after(() => {
    fs.rmSync(build, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const binary = path.join(build, "worker");
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  execFileSync("/usr/bin/xcrun", ["swiftc", "-parse-as-library", "-swift-version", "5",
    "-target", arch + "-apple-macosx14.0", "-D", "ONLINE_SUBTITLE_TEST",
    path.join(root, "MacHelperExtension/Main.swift"), sdk, "-o", binary]);

  let failure;
  let chatCalls = 0;
  let enteredCancellation;
  let observedCancellation;
  const cancelStarted = new Promise(resolve => { enteredCancellation = resolve; });
  const cancelReachedOllama = new Promise(resolve => { observedCancellation = resolve; });
  const live = process.env.ONLINE_SUBTITLE_TEST_LIVE === "1";
  const fixture = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/tags") {
      response.end(JSON.stringify({ models: [
        { name: "cloud-alias", size: 1, remote_host: "https://example.invalid" },
        { name: "qwen-cloud", size: 1 },
        { name: "gemma:2b", size: 2 },
        { name: "qwen:4b", size: 4 }
      ] }));
      return;
    }
    chatCalls++;
    try {
      assert.equal(request.url, "/api/chat");
      const input = JSON.parse(Buffer.concat(chunks));
      assert.equal(input.model, "qwen:4b:local");
      assert.equal(input.think, false);
      assert.equal(input.tools, undefined);
      assert.equal(input.messages[0].role, "system");
      assert.match(input.messages[0].content, /quoted source material/);
      const cues = JSON.parse(input.messages[1].content);
      if (cues[0].text === "Cancellation fixture.") {
        response.once("close", observedCancellation);
        enteredCancellation();
        return;
      }
      assert.equal(cues[1].text, "Please close the window.");
      response.end(JSON.stringify({ done: true, message: { content: JSON.stringify({
        translations: [{ id: 1, text: "外面在下雨。" }, { id: 2, text: "请把窗户关上。" }]
      }) }}));
    } catch (error) {
      failure = error;
      response.writeHead(400).end();
    }
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  t.after(() => { fixture.closeAllConnections(); fixture.close(); });
  const worker = spawn(binary, [], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ONLINE_SUBTITLE_TEST_ID: id, ONLINE_SUBTITLE_TEST_OLLAMA: live
      ? "http://127.0.0.1:11434" : "http://127.0.0.1:" + fixture.address().port }
  });
  t.after(() => worker.kill());
  const loaded = readFrame(worker.stdout);
  worker.stdin.write(frame({
    id: "load", method: "load", generation: "test", settings: {}, resources: {}, permissions: ["native.execute"]
  }));
  assert.deepEqual(await loaded, { id: "load", generation: "test", ok: true, result: { __loaded: true, commands: ["status"] } });
  const endpoint = fs.readFileSync(path.join(directory, "endpoint"), "utf8");
  assert.match(endpoint, /^[a-f0-9]{32}\.sock$/);
  const socketPath = path.join(directory, endpoint);
  function send(request) {
    const socket = net.createConnection(socketPath);
    const answer = readFrame(socket).finally(() => socket.destroy());
    socket.write(frame(request));
    return answer;
  }

  assert.deepEqual(await send({ type: "listModels", cues: [] }), { ok: false, error: "invalid" });
  const start = performance.now();
  const result = await send({ type: "translate", cues: [
    { id: 1, text: "It's raining outside." }, { id: 2, text: "Please close the window." }
  ] });
  assert.ifError(failure);
  if (live) {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.translations.map(cue => cue.id), [1, 2]);
    assert.ok(result.translations.every(cue => /\p{Script=Han}/u.test(cue.text)));
    t.diagnostic("Two public synthetic cues translated locally in " + ((performance.now() - start) / 1000).toFixed(1) + " s.");
  } else {
    assert.equal(chatCalls, 1);
    assert.deepEqual(result, {
      ok: true, translations: [{ id: 1, text: "外面在下雨。" }, { id: 2, text: "请把窗户关上。" }]
    });
    const canceled = net.createConnection(socketPath);
    canceled.write(frame({ type: "translate", cues: [{ id: 3, text: "Cancellation fixture." }] }));
    await cancelStarted;
    canceled.destroy();
    let cancellationTimer;
    try {
      await Promise.race([cancelReachedOllama, new Promise((_, reject) => {
        cancellationTimer = setTimeout(() => reject(new Error("Ollama did not observe connection cancellation.")), 3000);
      })]);
    } finally {
      clearTimeout(cancellationTimer);
    }
  }

  const stopped = readFrame(worker.stdout);
  worker.stdin.write(frame({ id: "stop", method: "stop", generation: "test" }));
  assert.deepEqual(await stopped, { id: "stop", generation: "test", ok: true, result: { stopped: true } });
  assert.equal(fs.existsSync(socketPath), false);
});
