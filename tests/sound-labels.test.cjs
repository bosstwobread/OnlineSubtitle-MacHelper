const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const context = {};
vm.runInNewContext(readFileSync(path.join(__dirname, "../Chrome/sound-labels.js"), "utf8"), context);
const removeSoundLabels = context.onlineSubtitleRemoveSoundLabels;

test("removes standalone allowlisted labels and music-note cues", () => {
  for (const text of ["[Music]", "[background MUSIC].", " (laughter and applause) ", "[ ♪♫ ]", "♪ ♫ ♬", "[Music] ♪",
    "【背景音乐】", "（掌聲）", "［拍手］", "[박수]", "[musique de fond]", "[música]", "[Hintergrundmusik]",
    "[applausi]", "[смех]", "[तालियाँ]", "[تصفيق]"]) {
    assert.equal(removeSoundLabels(text), "", text);
  }
});

test("removes inline sound labels with natural punctuation and spacing", () => {
  assert.equal(removeSoundLabels("[Music] Come on, [applause] let's go. (cheering)"), "Come on, let's go.");
  assert.equal(removeSoundLabels("Wait [Footsteps], Maya."), "Wait, Maya.");
  assert.equal(removeSoundLabels("We  kept [Music] walking  home."), "We  kept walking  home.");
  assert.equal(removeSoundLabels("Welcome[music][applause]home!"), "Welcome home!");
  assert.equal(removeSoundLabels("我们【音乐】继续，［掌聲］好的。"), "我们继续，好的。");
  assert.equal(removeSoundLabels("彼は【音楽】、次へ進む。"), "彼は、次へ進む。");
});

test("preserves ordinary speech, lyrics, unknown brackets, and nested or malformed labels", () => {
  for (const text of [
    "Music matters, and applause followed.",
    "♪ Let's sing together ♪",
    "[Maya] will start at [6:30].",
    "We heard [inaudible] and [speaking French].",
    "See (chapter 4) for the definition.",
    "[music discussion] stayed on the agenda.",
    "[[music]] can be entered here.",
    "The title was [Chapter [music]].",
    "A literal (music] [applause]"
  ]) {
    assert.equal(removeSoundLabels(text), text);
  }
  assert.equal(removeSoundLabels("[Maya] [Applause] Let’s begin."), "[Maya] Let’s begin.");
});

test("preserves explicitly quoted sound labels and strips a separate unquoted label", () => {
  const cases = [
    ['She said "[Music]" [applause].', 'She said "[Music]".'],
    ['He typed "the [music] cue" [laughter].', 'He typed "the [music] cue".'],
    ["'It's written [music]' [laughing]", "'It's written [music]'"],
    ["他说「[音乐]」［掌声］然后继续。", "他说「[音乐]」然后继续。"],
    ["She quoted « [musique] » (rires).", "She quoted « [musique] »."],
    ["He opened with “the words [music]", "He opened with “the words [music]"],
    ["[music]” is a literal label.", "[music]” is a literal label."]
  ];
  for (const [input, expected] of cases) assert.equal(removeSoundLabels(input), expected);
});

test("treats contractions, plurals, and inch marks as speech", () => {
  assert.equal(removeSoundLabels("It's [music] time, isn't it?"), "It's time, isn't it?");
  assert.equal(removeSoundLabels("We heard the singers' [dog barking] rehearsal."), "We heard the singers' rehearsal.");
  assert.equal(removeSoundLabels('Cut a 6" [music] board.'), 'Cut a 6" board.');
});

test("leaves long input and oversized bracket contents untouched", () => {
  const longCaption = "x".repeat(1_000) + " [music]";
  const longLabel = "[" + " ".repeat(70) + "music] Keep speaking.";
  assert.equal(removeSoundLabels(longCaption), longCaption);
  assert.equal(removeSoundLabels(longLabel), longLabel);
});
