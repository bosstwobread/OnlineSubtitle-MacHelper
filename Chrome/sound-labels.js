(() => {
  "use strict";

  const maximumCueLength = 1_000;
  const maximumLabelLength = 64;
  const bracketPairs = new Map([["[", "]"], ["(", ")"], ["［", "］"], ["（", "）"], ["【", "】"]]);
  const quotePairs = new Map([
    ['"', '"'], ["'", "'"], ["“", "”"], ["‘", "’"], ["«", "»"], ["‹", "›"],
    ["„", "“"], ["‚", "‘"], ["「", "」"], ["『", "』"]
  ]);
  const closingQuotes = new Set(quotePairs.values());
  const wordCharacter = /[\p{L}\p{M}\p{N}]/u;
  const musicNotes = /^[\s♪♫♬♩]+$/u;
  const soundLabels = new Set([
    "music", "background music", "upbeat music", "soft music", "instrumental music", "dramatic music",
    "music playing", "music plays", "music starts", "music stops", "music fades",
    "applause", "audience applause", "clapping", "cheering", "crowd cheering", "cheering and applause",
    "laughter", "laughs", "laughing", "audience laughter", "audience laughs", "laughter and applause",
    "sighs", "coughs", "coughing", "sneezes", "footsteps",
    "doorbell rings", "phone ringing", "birds chirping", "dog barking", "sound effect", "sound effects",
    "音乐", "音樂", "背景音乐", "背景音樂", "掌声", "掌聲", "鼓掌", "笑声", "笑聲",
    "欢呼声", "歡呼聲", "脚步声", "腳步聲", "门铃声", "門鈴聲",
    "音楽", "bgm", "拍手", "笑い声", "歓声", "効果音", "足音",
    "음악", "배경 음악", "박수", "웃음소리", "환호", "효과음",
    "musique", "musique de fond", "applaudissements", "rires", "bruits de pas",
    "música", "música de fondo", "aplausos", "risas", "música de fundo", "risadas", "risos",
    "musik", "hintergrundmusik", "applaus", "lachen", "jubel",
    "musica", "musica di sottofondo", "applausi", "risate",
    "музыка", "фоновая музыка", "аплодисменты", "смех",
    "संगीत", "पृष्ठभूमि संगीत", "तालियाँ", "तालियां", "हँसी", "हंसी",
    "موسيقى", "موسيقى خلفية", "تصفيق", "ضحك", "ضحكات"
  ]);

  function isSoundLabel(label) {
    const normalized = label.normalize("NFC").trim().toLowerCase().replace(/\s+/gu, " ");
    return soundLabels.has(normalized) || musicNotes.test(normalized);
  }

  function soundLabelRanges(text) {
    const ranges = [];
    const expectedBrackets = [];
    let bracketStart;
    let nested = false;
    let expectedQuote;

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      const previous = text[index - 1] ?? "";
      const following = text[index + 1] ?? "";
      if (expectedQuote) {
        if (character === expectedQuote && previous !== "\\"
            && (!/['’]/u.test(character) || !wordCharacter.test(previous) || !wordCharacter.test(following))) {
          expectedQuote = undefined;
        }
        continue;
      }
      if (!expectedBrackets.length && quotePairs.has(character) && previous !== "\\"
          && !(character === "'" && wordCharacter.test(previous))
          && !(character === '"' && /\p{N}/u.test(previous))) {
        expectedQuote = quotePairs.get(character);
        continue;
      }
      if (bracketPairs.has(character)) {
        nested = expectedBrackets.length > 0;
        if (!nested) bracketStart = index;
        expectedBrackets.push(bracketPairs.get(character));
        continue;
      }
      if (character !== expectedBrackets.at(-1)) continue;
      expectedBrackets.pop();
      if (!expectedBrackets.length && !nested && index - bracketStart - 1 <= maximumLabelLength
          && !closingQuotes.has(following) && isSoundLabel(text.slice(bracketStart + 1, index))) {
        ranges.push({start: bracketStart, end: index + 1});
      }
    }
    return ranges;
  }

  function joinSpeech(left, right) {
    const leftText = left.trimEnd();
    const rightText = right.trimStart();
    if (!leftText || !rightText) return leftText || rightText;
    if (/[\p{Ps}\p{Pi}]$/u.test(leftText) || /^[\p{Pe}\p{Pf},.;:!?%。，、！？：；…]/u.test(rightText)) {
      return leftText + rightText;
    }
    const originalSpace = left.slice(leftText.length) || right.slice(0, right.length - rightText.length);
    if (originalSpace) return leftText + originalSpace + rightText;
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}、，：；]$/u.test(leftText)
        && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(rightText)) {
      return leftText + rightText;
    }
    const needsSpace = /[\p{L}\p{M}\p{N}]$/u.test(leftText) && /^[\p{L}\p{M}\p{N}]/u.test(rightText);
    return leftText + (needsSpace ? " " : "") + rightText;
  }

  globalThis.onlineSubtitleRemoveSoundLabels = function removeSoundLabels(text) {
    if (typeof text !== "string" || text.length > maximumCueLength) return text;
    if (musicNotes.test(text) && text.trim()) return "";
    const ranges = soundLabelRanges(text);
    if (!ranges.length) return text;

    let speech = text.slice(0, ranges[0].start);
    for (let index = 0; index < ranges.length; index += 1) {
      speech = joinSpeech(speech, text.slice(ranges[index].end, ranges[index + 1]?.start));
    }
    return /^[\s\p{P}♪♫♬♩]*$/u.test(speech) ? "" : speech;
  };
})();
