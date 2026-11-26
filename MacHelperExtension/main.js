"use strict";

(() => {
  const maximumFrameBytes = 32 * 1024;
  const languages = new Set(["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "pt", "it"]);
  const promptPaths = ["prompts/translate-captions.txt", "prompts/translate-sentences.txt", "prompts/word-in-context.txt"];
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const revisions = new Map();
  let prompts;

  class CaptionFailure extends Error {}

  function trim(text) {
    // Foundation's whitespace set also includes the zero-width space.
    return text.replace(/^[\p{White_Space}\u200B]+|[\p{White_Space}\u200B]+$/gu, "");
  }

  function byteLength(text) {
    if (typeof text !== "string") return Infinity;
    // This ECMAScript context has no TextEncoder. URI encoding also rejects
    // unpaired surrogates, which the previous worker could not decode.
    try { return encodeURIComponent(text).replace(/%[0-9A-F]{2}/g, " ").length; }
    catch { return Infinity; }
  }

  function validText(text, maximumBytes) {
    return typeof text === "string" && text.length <= maximumBytes &&
      byteLength(text) <= maximumBytes && trim(text) !== "" &&
      !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text);
  }

  function hasKeys(value, ...keys) {
    return value !== null && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  }

  function parseFrame(text, failure) {
    if (byteLength(text) > maximumFrameBytes) throw new CaptionFailure(failure);
    try { return JSON.parse(text); }
    catch { throw new CaptionFailure(failure); }
  }

  function readPrompt(path) {
    let value;
    try { value = MacHelper.readText(path); } catch { return null; }
    if (byteLength(value) > 48_000 || value.includes("\0") || trim(value) === "") return null;
    let count = 0;
    for (const _ of graphemes.segment(value)) {
      if (++count > 12_000) return null;
    }
    return value;
  }

  function readSettings(input) {
    let targetLanguage = input.settings?.targetLanguage;
    if (!languages.has(targetLanguage)) targetLanguage = "zh-CN";
    // MacHelper freezes resources for each worker generation.
    prompts ??= promptPaths.map(readPrompt);
    if (!revisions.has(targetLanguage)) {
      revisions.set(targetLanguage, sha256([targetLanguage, ...prompts].join("\0")));
    }
    return { targetLanguage, revision: revisions.get(targetLanguage) };
  }

  function decodeCues(text) {
    const request = parseFrame(text, "invalid");
    if (!hasKeys(request, "type", "cues") || !["translate", "translateSentences"].includes(request.type) ||
        !Array.isArray(request.cues) || request.cues.length < 1 || request.cues.length > 8 ||
        !request.cues.every(cue => hasKeys(cue, "id", "text") && Number.isSafeInteger(cue.id) &&
          cue.id > 0 && validText(cue.text, 1_000)) ||
        new Set(request.cues.map(cue => cue.id)).size !== request.cues.length) {
      throw new CaptionFailure("invalid");
    }
    return request;
  }

  function decodeWord(text) {
    const request = parseFrame(text, "invalid");
    if (!hasKeys(request, "type", "word", "sentence") || request.type !== "explainWord" ||
        !validText(request.word, 256) || request.word !== trim(request.word) ||
        !validText(request.sentence, 2_000) || !request.sentence.includes(request.word)) {
      throw new CaptionFailure("invalid");
    }
    return request;
  }

  function decodeModel(answer) {
    if (byteLength(answer) > maximumFrameBytes) throw new CaptionFailure("translation");
    let text = trim(answer).replaceAll("\r\n", "\n");
    if (text.startsWith("```json\n") || text.startsWith("```\n")) {
      const bodyStart = text.indexOf("\n") + 1;
      if (text.endsWith("\n```") && bodyStart <= text.length - 4) {
        text = text.slice(bodyStart, -4);
      }
    }
    return parseFrame(text, "translation");
  }

  function decodeTranslations(answer, cues, allowsSource) {
    const value = decodeModel(answer);
    if (!hasKeys(value, "translations") || !Array.isArray(value.translations) ||
        value.translations.length !== cues.length) throw new CaptionFailure("translation");
    return value.translations.map((row, index) => {
      const corrected = allowsSource && hasKeys(row, "id", "text", "source") && validText(row.source, 1_000);
      if ((!corrected && !hasKeys(row, "id", "text")) || row.id !== cues[index].id || !validText(row.text, 2_000)) {
        throw new CaptionFailure("translation");
      }
      const translation = { id: row.id, text: row.text };
      if (corrected && row.source.normalize("NFC") !== cues[index].text.normalize("NFC")) {
        translation.source = row.source;
      }
      return translation;
    });
  }

  function decodeMeaning(answer) {
    const value = decodeModel(answer);
    const legacy = hasKeys(value, "meaning", "sentenceMeaning") && validText(value.sentenceMeaning, 2_000);
    if ((!legacy && !hasKeys(value, "meaning")) || !validText(value.meaning, 2_000)) {
      throw new CaptionFailure("translation");
    }
    return value.meaning;
  }

  function reply(value) {
    const text = JSON.stringify(value);
    if (byteLength(text) > maximumFrameBytes) throw new CaptionFailure("translation");
    return { text };
  }

  function failure(error) {
    return reply({ ok: false, error: error instanceof CaptionFailure ? error.message : "translation" });
  }

  async function transform(prompt, targetLanguage, data) {
    if (prompt === null) throw new CaptionFailure("unavailable");
    const result = await MacHelper.ai.transform({
      action: "translate", targetLanguage, systemPrompt: prompt,
      text: JSON.stringify({ targetLanguage, ...data })
    });
    return result?.text;
  }

  // SHA-256 keeps the browser's existing cache revision stable across
  // worker runtimes. Its input comprises the language and bounded prompts.
  function sha256(text) {
    const rounds = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    const state = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19);
    const bytes = encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    const blockSize = 64;
    const data = new Uint8Array(Math.ceil((bytes.length + 9) / blockSize) * blockSize);
    for (let i = 0; i < bytes.length; i++) data[i] = bytes.charCodeAt(i);
    data[bytes.length] = 0x80;
    const view = new DataView(data.buffer);
    view.setUint32(data.length - 4, bytes.length * 8);
    const schedule = new Uint32Array(64);
    const rotate = (word, bits) => (word >>> bits) | (word << (32 - bits));

    for (let offset = 0; offset < data.length; offset += blockSize) {
      for (let i = 0; i < 16; i++) schedule[i] = view.getUint32(offset + i * 4);
      for (let i = 16; i < 64; i++) {
        const prev = schedule[i - 15], near = schedule[i - 2];
        const first = rotate(prev, 7) ^ rotate(prev, 18) ^ (prev >>> 3);
        const second = rotate(near, 17) ^ rotate(near, 19) ^ (near >>> 10);
        schedule[i] = schedule[i - 16] + first + schedule[i - 7] + second;
      }
      let [a, b, c, d, e, f, g, h] = state;
      for (let i = 0; i < 64; i++) {
        const sigmaE = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
        const choice = (e & f) ^ (~e & g);
        const temp1 = h + sigmaE + choice + rounds[i] + schedule[i];
        const sigmaA = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        h = g; g = f; f = e; e = (d + temp1) | 0;
        d = c; c = b; b = a; a = (temp1 + sigmaA + majority) | 0;
      }
      [a, b, c, d, e, f, g, h].forEach((value, i) => { state[i] += value; });
    }
    return Array.from(state, value => value.toString(16).padStart(8, "0")).join("");
  }

  MacHelper.define({ commands: {
    status() { return { title: "OnlineSubtitle", text: "OnlineSubtitle is ready for its YouTube companion." }; },

    "caption-settings"(input) {
      try {
        const request = parseFrame(input.text, "invalid");
        if (!hasKeys(request, "type") || request.type !== "getSettings") throw new CaptionFailure("invalid");
        return reply({ ok: true, ...readSettings(input) });
      } catch (error) { return failure(error); }
    },

    async "translate-captions"(input) {
      try {
        const { type, cues } = decodeCues(input.text);
        const settings = readSettings(input);
        const sentencePrompt = type === "translateSentences" ? prompts[1] : null;
        const answer = await transform(sentencePrompt ?? prompts[0], settings.targetLanguage, { cues });
        const translations = decodeTranslations(answer, cues, sentencePrompt !== null);
        return reply({ ok: true, translations, ...settings });
      } catch (error) { return failure(error); }
    },

    async "explain-word"(input) {
      try {
        const { word, sentence } = decodeWord(input.text);
        const settings = readSettings(input);
        const answer = await transform(prompts[2], settings.targetLanguage, { word, sentence });
        return reply({ ok: true, meaning: decodeMeaning(answer), ...settings });
      } catch (error) { return failure(error); }
    }
  } });
})();
