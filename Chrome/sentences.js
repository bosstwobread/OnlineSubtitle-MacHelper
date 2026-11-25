(() => {
  "use strict";

  const maximumGap = 0.35;
  const maximumOverlap = 0.10;
  const maximumSpan = 8;
  const maximumColumns = 140;
  const maximumSentenceSpan = 18;
  const maximumSentenceColumns = 220;
  const maximumSentenceLookahead = 12;
  const maximumStarterGap = 1.25;
  const maximumBytes = 1_000;
  const timingTolerance = 1e-6;
  const encoder = new TextEncoder();
  const defaultSentenceBoundaries = new Intl.Segmenter(undefined, { granularity: "sentence" });
  const wideCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/u;
  const captionMarker = /^(?:[\[(]|[-–—]\s|>>?|[\p{Lu}\p{Script=Han}][\p{L}\p{M}\p{N} .'’()-]{0,23}(?::\s|：))|[♪♫]|[\])]$/u;
  const dependentStarter = /^(?:(?:and|but|so) )?(?:if|when|while|because|although|though|unless|until|since|whereas|even (?:if|though|when)|as (?:if|long as))$/iu;

  function endsSentence(text, next) {
    const end = text.trimEnd().replace(/[\p{Pe}\p{Pf}"']+$/u, "").trimEnd();
    if (!end.endsWith(".")) return /[\p{Sentence_Terminal}…．｡]$/u.test(end);
    if (end.endsWith("...")) return true;

    const following = next.trimStart();
    if (/\b(?:Mr|Mrs|Ms|Mx|Dr|Prof|Rev|Hon|Capt|Sgt)\.$/iu.test(end) && /^\p{L}/u.test(following)) return false;
    if (/\b(?:no|fig|vol|sec|ch)\.$/iu.test(end) && /^\p{N}/u.test(following)) return false;
    if (/\b(?:e\.g\.|i\.e\.|cf\.)$/iu.test(end) && /^[\p{L}\p{N}]/u.test(following)) return false;
    if (/(?:\b[A-Za-z]\.){2,}$/u.test(end)) return !/^[\p{Ll}\p{N}]/u.test(following);

    // A name can continue after a dotted initial, while labels such as “Plan A.” can end a sentence.
    if (/\b[A-Z]\.$/u.test(end) && /^[\p{Lu}](?:[\p{Ll}\p{M}]|\.)/u.test(following)
        && !/\b(?:plan|option|choice|appendix|part|chapter|section|vitamin|grade|type)\s+[A-Z]\.$/iu.test(end)
        && !/^(?:He|She|It|We|They|You|This|That|Then|Now|But|The|And|After|Before|When)\b/u.test(following)) {
      return false;
    }
    return true;
  }

  function joinText(left, right) {
    const leftUsesNoSpace = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}、，：；」』）】》〉]$/u.test(left);
    const rightUsesNoSpace = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}「『（【《〈]/u.test(right);
    if ((leftUsesNoSpace && rightUsesNoSpace) || /[\s\p{Ps}\p{Pi}]$/u.test(left)
        || /^[\s\p{Pe}\p{Pf}\p{Sentence_Terminal},;:%。，、：；…،؛]/u.test(right)) return left + right;
    return left + " " + right;
  }

  function fitsWidth(text, limit = maximumColumns) {
    let columns = 0;
    for (const character of text) {
      if (/[\p{Mark}\u200c\u200d]/u.test(character)) continue;
      columns += wideCharacter.test(character) ? 2 : 1;
      if (columns > limit) return false;
    }
    return encoder.encode(text).length <= maximumBytes;
  }

  function splitCue(cue, remainingSplits, sentenceBoundaries) {
    if (!remainingSplits) return [cue];

    const parts = [];
    let offset = 0;
    for (const { index } of sentenceBoundaries.segment(cue.text)) {
      if (index === 0) continue;
      const text = cue.text.slice(offset, index).trim();
      if (endsSentence(text, cue.text.slice(index))) {
        parts.push(text);
        offset = index;
        if (parts.length > remainingSplits) return [cue];
      }
    }
    if (parts.length === 0) return [cue];
    parts.push(cue.text.slice(offset).trim());

    // YouTube transcript cues provide times for the whole block. Estimate
    // internal boundaries from spoken text while retaining the outer times.
    const weights = parts.map(text => text.match(/[\p{L}\p{N}]/gu)?.length || 1);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let elapsedWeight = 0;
    let start = cue.start;
    const timed = [];
    for (const [index, text] of parts.entries()) {
      elapsedWeight += weights[index];
      const end = index === parts.length - 1
        ? cue.end
        : cue.start + (cue.end - cue.start) * (elapsedWeight / total);
      if (end <= start) return [cue];
      timed.push({ start, end, text });
      start = end;
    }
    return timed;
  }

  function splitTimedCues(sortedCues, limit, sentenceBoundaries) {
    const fragments = [];
    let remainingSplits = Math.max(0, limit - sortedCues.length);
    let latestEnd = 0;
    for (const [index, cue] of sortedCues.entries()) {
      const next = sortedCues[index + 1];
      const nextOverlap = next ? cue.end - next.start : 0;
      // A following cue that outlasts this one already replaces it on screen.
      // Use its visible span so new parts cannot overtake the next cue.
      const replacesCue = next && next.start > cue.start && next.end > cue.end &&
        nextOverlap > maximumOverlap + timingTolerance;
      const visible = replacesCue ? { ...cue, end: next.start } : cue;
      const overlap = Math.max(latestEnd - cue.start, replacesCue ? 0 : nextOverlap);
      const parts = overlap > maximumOverlap + timingTolerance ? [visible] : splitCue(visible, remainingSplits, sentenceBoundaries);
      fragments.push(...parts);
      remainingSplits -= parts.length - 1;
      latestEnd = Math.max(latestEnd, visible.end);
    }
    return fragments.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  function canJoin(text, previous, cue, gapLimit = maximumGap) {
    const gap = cue.start - previous.end;
    return cue.start > previous.start && cue.end > previous.end
      && gap >= -maximumOverlap - timingTolerance && gap <= gapLimit + timingTolerance
      && (gap >= 0 || cue.text !== previous.text)
      && !captionMarker.test(previous.text.trim()) && !captionMarker.test(cue.text.trim())
      && !endsSentence(text, cue.text);
  }

  function fitsSentence(start, end, text) {
    return end - start <= maximumSentenceSpan + timingTolerance && fitsWidth(text, maximumSentenceColumns);
  }

  function hasNearbySentenceEnd(cues, index, start, text) {
    const limit = Math.min(cues.length, index + maximumSentenceLookahead);
    for (let at = index; at < limit; at++) {
      const cue = cues[at];
      if (!fitsSentence(start, cue.end, text)) return false;
      const next = cues[at + 1];
      if (endsSentence(text, next?.text ?? "")) return true;
      if (!next || !canJoin(text, cue, next)) return false;
      text = joinText(text, next.text);
    }
    return false;
  }

  globalThis.onlineSubtitleGroupCaptionSentences = function groupCaptionSentences(sortedCues, limit = 10_000, language) {
    let sentenceBoundaries = defaultSentenceBoundaries;
    if (language) {
      try { sentenceBoundaries = new Intl.Segmenter(language, { granularity: "sentence" }); }
      catch { /* Use the browser default if YouTube supplied an unrecognized language tag. */ }
    }
    const groups = [];
    const fragments = splitTimedCues(sortedCues, limit, sentenceBoundaries);
    let previous;
    for (const [index, cue] of fragments.entries()) {
      const group = groups.at(-1);
      const starter = group && dependentStarter.test(group.text);
      if (group && canJoin(group.text, previous, cue, starter ? maximumStarterGap : maximumGap)) {
        const text = joinText(group.text, cue.text);
        // Prefer a nearby sentence end over the normal display target. A bare
        // opener also gets to its following cue when the rest is too long.
        if ((cue.end - group.start <= maximumSpan + timingTolerance && fitsWidth(text))
          || (starter && fitsSentence(group.start, cue.end, text))
          || hasNearbySentenceEnd(fragments, index, group.start, text)) {
          group.end = cue.end;
          group.text = text;
          previous = cue;
          continue;
        }
      }
      groups.push({start: cue.start, end: cue.end, text: cue.text});
      previous = cue;
    }
    return groups;
  };
})();
