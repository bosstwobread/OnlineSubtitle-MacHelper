const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const context = {TextEncoder};
vm.runInNewContext(readFileSync(path.join(__dirname, "../Chrome/sentences.js"), "utf8"), context);

function cue(start, end, text) {
  return {start, end, text};
}

function grouped(cues, language) {
  return structuredClone(context.onlineSubtitleGroupCaptionSentences(cues, undefined, language));
}

test("joins adjacent unfinished cues using their real outer timestamps", () => {
  const cues = Object.freeze([
    Object.freeze(cue(0, 1.2, "When Maya arrived,")),
    Object.freeze(cue(1.4, 2.08, "we were already")),
    Object.freeze(cue(2, 3.12, "leaving.")),
    Object.freeze(cue(3.22, 4, "She called. We stopped."))
  ]);
  assert.deepEqual(grouped(cues), [
    cue(0, 3.12, "When Maya arrived, we were already leaving."),
    cue(3.22, (3.22 + 4) / 2, "She called."),
    cue((3.22 + 4) / 2, 4, "We stopped.")
  ]);
  const result = context.onlineSubtitleGroupCaptionSentences(cues);
  assert.notEqual(result[1], cues[3]);
  assert.deepEqual(Object.keys(result[0]), ["start", "end", "text"]);
  assert.deepEqual(grouped([]), []);
});

test("preserves abbreviations, decimal punctuation, and quotes inside split cues", () => {
  const result = grouped([cue(4, 12, "Dr. J. Lin paid $1,234.50. “Wait!” Maya said.")]);
  assert.deepEqual(result.map(({ text }) => text), [
    "Dr. J. Lin paid $1,234.50.", "“Wait!”", "Maya said."
  ]);
  assert.equal(result[0].start, 4);
  assert.equal(result.at(-1).end, 12);
  assert.ok(result.slice(1).every((part, index) => part.start === result[index].end && part.end > part.start));
  assert.deepEqual(grouped([cue(0, 4, "他说完了。下一句话。")]).map(({ text }) => text), ["他说完了。", "下一句话。"]);
});

test("preserves genuinely overlapping cue order and keeps all text when its split budget runs out", () => {
  const overlapping = [cue(0, 5, "One sentence. Another sentence."), cue(1, 3, "Simultaneous speaker.")];
  assert.deepEqual(grouped(overlapping), overlapping);
  const cues = [cue(0, 4, "One. Two. Three."), cue(4, 6, "Four. Five.")];
  assert.deepEqual(structuredClone(context.onlineSubtitleGroupCaptionSentences(cues, 2)), cues);
});

test("keeps titles and dotted initials together while preserving numbers and sentence ends", () => {
  const cues = [
    cue(0, 1, "We met Dr."),
    cue(1, 2, "J."),
    cue(2, 3, "Lin at 6:30 p.m."),
    cue(3, 4, "and paid $1,234.50."),
    cue(4, 5, "It was Plan A."),
    cue(5, 6, "Maya called from the U.S."),
    cue(6, 7, "before Friday."),
    cue(7, 8, "He stayed in the U.S."),
    cue(8, 9, "Maya called again.")
  ];
  assert.deepEqual(grouped(cues), [
    cue(0, 4, "We met Dr. J. Lin at 6:30 p.m. and paid $1,234.50."),
    cues[4],
    cue(5, 7, "Maya called from the U.S. before Friday."),
    cues[7],
    cues[8]
  ]);
  assert.deepEqual(grouped([cue(0, 1, "Go now."), cue(1, 2, "Then wait.")]), [
    cue(0, 1, "Go now."), cue(1, 2, "Then wait.")
  ]);
});

test("uses Han and Kana spacing and retains case and punctuation verbatim", () => {
  assert.deepEqual(grouped([
    cue(0, 1, "我们先看看"), cue(1, 2, "这个例子，"), cue(2, 3, "然后继续。"),
    cue(3, 4, "彼は答えた"), cue(4, 5, "「わかりました。」"), cue(5, 6, "彼女が待つ。")
  ]), [
    cue(0, 3, "我们先看看这个例子，然后继续。"),
    cue(3, 5, "彼は答えた「わかりました。」"),
    cue(5, 6, "彼女が待つ。")
  ]);
  assert.deepEqual(grouped([cue(0, 1, "저는"), cue(1, 2, "학생입니다.")]), [cue(0, 2, "저는 학생입니다.")]);
  assert.deepEqual(grouped([cue(0, 1, "“Wait!”"), cue(1, 2, "He left.")]), [
    cue(0, 1, "“Wait!”"), cue(1, 2, "He left.")
  ]);
});

test("groups Spanish fragments and respects Japanese and right-to-left sentence punctuation", () => {
  const texts = (cues, language) => grouped(cues, language).map(({text}) => text);
  assert.deepEqual(texts([
    cue(0, 1, "¿Quieres ir"), cue(1, 2, "al mercado? Sí, vamos."),
  ], "es"), ["¿Quieres ir al mercado?", "Sí, vamos."]);
  assert.deepEqual(texts([cue(0, 4, "今日は晴れです。明日も晴れます。")], "ja"),
    ["今日は晴れです。", "明日も晴れます。"]);
  assert.deepEqual(texts([cue(0, 4, "مرحبا، كيف الحال؟ أنا بخير.")], "ar"),
    ["مرحبا، كيف الحال؟", "أنا بخير."]);
  assert.deepEqual(texts([cue(0, 4, "آج اچھا دن ہے۔ چلو باہر جائیں۔")], "ur"),
    ["آج اچھا دن ہے۔", "چلو باہر جائیں۔"]);
});

test("preserves repeated words, substantial overlaps and coincident cues", () => {
  assert.deepEqual(grouped([cue(0, 1, "No,"), cue(1, 2, "no, wait.")]), [cue(0, 2, "No, no, wait.")]);
  const overlapping = [
    cue(0, 5, "I think we should"),
    cue(2, 3, "we should go"),
    cue(2, 4, "Another speaker"),
    cue(3.95, 5, "Another speaker")
  ];
  assert.deepEqual(grouped(overlapping), overlapping);
});

test("preserves speaker changes, sound labels, lyric markers and pauses", () => {
  const cues = [
    cue(0, 1, "I was about to"),
    cue(1, 2, "Maya: Wait a moment"),
    cue(2, 3, "No one moved"),
    cue(3, 4, "[Applause]"),
    cue(4, 5, "Then they stopped"),
    cue(5, 6, "♪ keep moving"),
    cue(6, 7, "only briefly"),
    cue(7.6, 8, "by the door"),
    cue(8, 9, "— Let me speak"),
    cue(9, 10, "but not yet")
  ];
  assert.deepEqual(grouped(cues), cues);
});

test("bounds runs without punctuation without inventing punctuation or timestamps", () => {
  const cues = [
    cue(0, 2.7, "we went to the river"),
    cue(2.7, 5.4, "and carried our books"),
    cue(5.4, 8, "and took a boat"),
    cue(8, 9.25, "and waited there")
  ];
  assert.deepEqual(grouped(cues), [
    cue(0, 8, "we went to the river and carried our books and took a boat"),
    cues[3]
  ]);
});

test("keeps a sentence beginning with a split-off And if together across a long transcript seam", () => {
  const firstSentence = "The latest research shows that people can develop new habits throughout their lives.";
  const continuation = "we give ourselves enough time to practise, we can improve our routines, our attitudes, and even parts of our";
  const ending = "daily interactions, including the way we respond to an unexpected problem.";
  const sentence = `And if ${continuation} ${ending}`;
  assert.ok(sentence.length > 140);
  const result = grouped([
    cue(24, 32, `${firstSentence} And if`),
    cue(32, 40, continuation),
    cue(40, 45, ending),
    cue(45, 46, "Here is an example.")
  ]);

  assert.ok(result[1].start > 31 && result[1].start < 32);
  assert.deepEqual(result, [
    cue(24, result[1].start, firstSentence),
    cue(result[1].start, 45, sentence),
    cue(45, 46, "Here is an example.")
  ]);
});

test("joins a short dependent starter across a brief pause without swallowing a speaker change", () => {
  const source = [
    cue(0, 1, "That depends."),
    cue(1, 1.2, "And if"),
    cue(1.85, 3, "you want to see the rest of it"),
    cue(3, 4, "— I already did.")
  ];
  assert.deepEqual(grouped(source), [source[0], cue(1, 3, "And if you want to see the rest of it"), source[3]]);
  const pause = [cue(0, 1, "And if"), cue(3, 4, "We go tomorrow.")];
  assert.deepEqual(grouped(pause), pause);
});

test("caps newly joined display widths and leaves lone oversized cues whole", () => {
  const narrow = [cue(0, 1, "a".repeat(69)), cue(1, 2, "b".repeat(70))];
  assert.deepEqual(grouped(narrow), [cue(0, 2, narrow[0].text + " " + narrow[1].text)]);
  narrow[0].text += "a";
  assert.deepEqual(grouped(narrow), narrow);

  const wide = [cue(0, 1, "字".repeat(35)), cue(1, 2, "句".repeat(36))];
  assert.deepEqual(grouped(wide), wide);
  const oversized = [cue(0, 10, "x".repeat(180)), cue(10, 11, "end.")];
  assert.deepEqual(grouped(oversized), [cue(0, 11, oversized[0].text + " end.")]);
  const beyondSentenceLimit = [cue(0, 10, "x".repeat(220)), cue(10, 11, "end.")];
  assert.deepEqual(grouped(beyondSentenceLimit), beyondSentenceLimit);
});

test("caps merged UTF-8 size even for zero-width combining marks", () => {
  const cues = [cue(0, 1, "a" + "\u0301".repeat(260)), cue(1, 2, "b" + "\u0301".repeat(260))];
  assert.deepEqual(grouped(cues), cues);
});
