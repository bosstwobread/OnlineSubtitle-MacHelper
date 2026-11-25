"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const translationPrompt = "prompts/translate-captions.txt";
const sentencePrompt = "prompts/translate-sentences.txt";

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

test("the standalone worker validates captions and uses the MacHelper native SDK", { timeout: 40_000 }, async t => {
  const build = fs.mkdtempSync(path.join(os.tmpdir(), "online-subtitle-worker-"));
  const binary = path.join(build, "worker");
  const extension = path.join(root, "MacHelperExtension");
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, "extension.json"), "utf8"));
  const resources = Object.fromEntries([translationPrompt, sentencePrompt].map(relative =>
    [relative, fs.readFileSync(path.join(extension, relative), "utf8")]
  ));
  t.after(() => fs.rmSync(build, { recursive: true, force: true }));
  execFileSync(path.join(root, "scripts/build-worker.sh"), [binary], { timeout: 30_000 });

  const worker = spawn(binary, [], { stdio: ["pipe", "pipe", "inherit"] });
  const exited = once(worker, "exit");
  t.after(async () => { worker.kill(); await exited; });
  async function request(id, method, payload) {
    const response = readFrame(worker.stdout);
    worker.stdin.write(frame({ id, method, generation: "test", ...payload }));
    return response;
  }
  function invokeCaption(id, payload) {
    return request(id, "invoke", { command: "translate-captions", input: { text: JSON.stringify(payload), settings: {} } });
  }
  function readCaptionReply(frame, id) {
    assert.equal(frame.id, id);
    assert.equal(frame.generation, "test");
    assert.equal(frame.ok, true);
    return JSON.parse(frame.result.text);
  }

  const cues = [{ id: 41, text: "We should nip this in the butt." }, { id: 42, text: "Let's do it soon." }];
  const translations = [{ id: 41, text: "我们应该防患于未然。" }, { id: 42, text: "我们尽快做吧。" }];
  async function replyFromModel(id, type, prompt, answer) {
    const capability = await invokeCaption(id, { type, cues });
    assert.equal(capability.type, "capability");
    assert.equal(capability.capability, "ai.transform");
    assert.equal(capability.generation, "test");
    assert.equal(typeof capability.id, "string");
    assert.equal(capability.payload.action, "translate");
    assert.equal(capability.payload.targetLanguage, "zh-CN");
    assert.equal(capability.payload.systemPrompt, resources[prompt]);
    assert.deepEqual(JSON.parse(capability.payload.text), cues);
    assert.equal(capability.payload.model, undefined);
    assert.equal(capability.payload.provider, undefined);
    const final = await request(capability.id, "capabilityResult", {
      ok: true, result: { text: JSON.stringify(answer), model: "test" }
    });
    return readCaptionReply(final, id);
  }

  assert.deepEqual(await request("load", "load", { settings: {}, resources, permissions: manifest.permissions }), {
    id: "load", generation: "test", ok: true, result: { __loaded: true, commands: ["status", "translate-captions"] }
  });
  assert.deepEqual(await request("status", "invoke", { command: "status", input: { text: "", settings: {} } }), {
    id: "status", generation: "test", ok: true,
    result: { title: "OnlineSubtitle", text: "OnlineSubtitle is ready for the Chrome companion." }
  });

  const invalid = await invokeCaption("invalid", { type: "translate", cues: [cues[0], cues[0]] });
  assert.deepEqual(readCaptionReply(invalid, "invalid"), { ok: false, error: "invalid" });
  assert.deepEqual(await replyFromModel("translate", "translate", translationPrompt, { translations }),
    { ok: true, translations });
  const revised = [
    { ...translations[0], source: "We should nip this in the bud." },
    { ...translations[1], source: cues[1].text }
  ];
  assert.deepEqual(
    await replyFromModel("sentences", "translateSentences", sentencePrompt, { translations: revised }),
    { ok: true, translations: [revised[0], translations[1]] }
  );
  assert.deepEqual(
    await replyFromModel("wrong-ids", "translate", translationPrompt, { translations: [...translations].reverse() }),
    { ok: false, error: "translation" }
  );
  assert.deepEqual(await request("stop", "stop"), {
    id: "stop", generation: "test", ok: true, result: { stopped: true }
  });
});
