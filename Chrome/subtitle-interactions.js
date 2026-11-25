(() => {
  "use strict";

  const edge = 10;
  const captionTop = 24;
  const minimumLookupSpace = 120;
  const closingPunctuation = /^[\p{Pe}\p{Pf}\p{Terminal_Punctuation}"'%…]+$/u;
  const handleMouseEvents = ["mousedown", "mouseup", "click", "dblclick"];
  let captionPosition;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function element(tag, className, text = "") {
    const node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  globalThis.onlineSubtitleCreateInteractions = function createInteractions({player, root, stack, original, translated, onWord, onDismiss, message}) {
    const handle = element("button", "online-subtitle-grab");
    handle.type = "button";
    handle.setAttribute("aria-label", message("moveSubtitles"));
    handle.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown");
    handle.title = message("moveSubtitles");
    stack.append(handle);

    const panel = element("section", "online-subtitle-lookup");
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", message("wordLookupTitle"));
    panel.dir = "auto";
    const header = element("header", "online-subtitle-lookup-header");
    const heading = element("h2", "online-subtitle-lookup-word");
    heading.dir = "auto";
    const close = element("button", "online-subtitle-lookup-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", message("closeWordLookup"));
    header.append(heading, close);

    const status = element("p", "online-subtitle-lookup-status");
    status.setAttribute("role", "status");
    const result = element("dl", "online-subtitle-lookup-result");
    result.setAttribute("aria-live", "polite");
    const meaning = element("dd", "online-subtitle-lookup-text");
    const sentence = element("dd", "online-subtitle-lookup-text");
    const meaningLabel = element("dt", "", message("wordMeaning"));
    const sentenceLabel = element("dt", "", message("sentenceMeaning"));
    for (const item of [meaningLabel, meaning, sentenceLabel, sentence]) item.dir = "auto";
    result.append(meaningLabel, meaning, sentenceLabel, sentence);
    panel.append(header, status, result);
    root.append(panel);

    let drag;
    let focusReturn;

    function captionRange() {
      const reserve = Math.min(68, root.clientHeight * 0.17);
      const max = Math.max(0, root.clientHeight - stack.offsetHeight - captionTop);
      return { min: Math.min(reserve, max), max, reserve };
    }

    function layout() {
      const {min, max, reserve} = captionRange();
      if (!stack.hidden && captionPosition !== undefined) {
        stack.style.setProperty("--online-subtitle-bottom", `${min + captionPosition * (max - min)}px`);
      }
      if (panel.hidden) return;

      const rootTop = root.getBoundingClientRect().top;
      const rect = stack.getBoundingClientRect();
      const above = rect.top - rootTop - edge;
      const below = root.clientHeight - (rect.bottom - rootTop) - reserve - edge;
      if (stack.hidden || Math.max(above, below) < minimumLookupSpace) {
        panel.removeAttribute("data-online-subtitle-placement");
        return;
      }
      const placement = above >= minimumLookupSpace && above >= below ? "above" : "below";
      panel.setAttribute("data-online-subtitle-placement", placement);
      const boundary = placement === "above" ? root.clientHeight - above : root.clientHeight - below - reserve;
      panel.style.setProperty("--online-subtitle-lookup-inset", `${boundary}px`);
      panel.style.setProperty("--online-subtitle-lookup-space", `${placement === "above" ? above - edge : below}px`);
    }

    function captionBottom() {
      return root.getBoundingClientRect().bottom - stack.getBoundingClientRect().bottom;
    }

    function moveCaption(bottom) {
      const {min, max} = captionRange();
      if (!Number.isFinite(bottom) || max <= min) return;
      captionPosition = (clamp(bottom, min, max) - min) / (max - min);
      layout();
    }

    function stopDrag(releaseCapture = true) {
      if (!drag) return;
      const {pointerId} = drag;
      drag = undefined;
      handle.removeAttribute("data-online-subtitle-dragging");
      if (releaseCapture && handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    }

    handle.addEventListener("pointerdown", event => {
      event.stopPropagation();
      if (!event.isTrusted || !event.isPrimary || event.button !== 0 || !Number.isFinite(event.clientY) || drag || stack.hidden) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      drag = {pointerId: event.pointerId, startY: event.clientY, bottom: captionBottom()};
      handle.setAttribute("data-online-subtitle-dragging", "");
    });
    handle.addEventListener("pointermove", event => {
      if (!event.isTrusted || event.pointerId !== drag?.pointerId || !Number.isFinite(event.clientY)) return;
      event.stopPropagation();
      moveCaption(drag.bottom + drag.startY - event.clientY);
    });
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
      handle.addEventListener(name, event => {
        if (!event.isTrusted || event.pointerId !== drag?.pointerId) return;
        event.stopPropagation();
        // Let the browser release capture after pointerup so its click is
        // still targeted at the handle even if the pointer left the caption.
        stopDrag(false);
      });
    }
    function shieldHandle(event) {
      if (!event.composedPath().includes(handle)) return;
      event.preventDefault();
      event.stopPropagation();
    }
    // YouTube also listens for compatibility mouse events in the player.
    for (const name of handleMouseEvents) window.addEventListener(name, shieldHandle, true);
    handle.addEventListener("keydown", event => {
      if (!event.isTrusted || !["ArrowUp", "ArrowDown", "Enter", " "].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const step = Math.max(12, root.clientHeight * 0.04);
      moveCaption(captionBottom() + (event.key === "ArrowUp" ? step : -step));
    });

    function clearLookup() {
      panel.hidden = true;
      status.textContent = "";
      heading.textContent = "";
      meaning.textContent = "";
      sentence.textContent = "";
      focusReturn = undefined;
    }

    function dismiss() {
      const previous = focusReturn;
      clearLookup();
      if (previous?.isConnected) previous.focus({preventScroll: true});
      onDismiss();
    }

    close.addEventListener("click", event => {
      event.stopPropagation();
      if (event.isTrusted) dismiss();
    });
    close.addEventListener("pointerdown", event => event.stopPropagation());
    panel.addEventListener("click", event => event.stopPropagation());
    panel.addEventListener("keydown", event => event.stopPropagation());
    function escapeLookup(event) {
      if (!panel.hidden && event.isTrusted && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }
    }
    root.addEventListener("keydown", escapeLookup, true);

    const resize = new ResizeObserver(layout);
    resize.observe(player);
    resize.observe(stack);

    function makeRenderer(line, side) {
      let displayedText;
      let displayedLanguage;
      let segmenter;
      return (text, language) => {
        if (!line || (displayedText === text && displayedLanguage === language)) return;
        if (!segmenter || displayedLanguage !== language) {
          try { segmenter = new Intl.Segmenter(language || undefined, {granularity: "word"}); }
          catch { segmenter = new Intl.Segmenter(undefined, {granularity: "word"}); }
        }
        displayedText = text;
        displayedLanguage = language;
        const parts = document.createDocumentFragment();
        const segments = [...segmenter.segment(text)];
        for (let index = 0; index < segments.length; index++) {
          const { segment, isWordLike } = segments[index];
          if (!isWordLike) {
            parts.append(document.createTextNode(segment));
            continue;
          }
          const word = element("button", "online-subtitle-word", segment);
          word.type = "button";
          word.addEventListener("pointerdown", event => event.stopPropagation());
          word.addEventListener("keydown", event => event.stopPropagation());
          word.addEventListener("click", event => {
            event.stopPropagation();
            if (!event.isTrusted || stack.hidden || !word.isConnected) return;
            heading.lang = language || "";
            onWord(segment, side);
            if (!panel.hidden) focusReturn = word;
          });
          let punctuation = "";
          for (let next = segments[index + 1]; next && !next.isWordLike && closingPunctuation.test(next.segment); next = segments[index + 1]) {
            punctuation += next.segment;
            index++;
          }
          if (punctuation) {
            const group = element("span", "online-subtitle-word-group");
            group.append(word, document.createTextNode(punctuation));
            parts.append(group);
          } else {
            parts.append(word);
          }
        }
        line.replaceChildren(parts);
      };
    }

    return {
      renderSource: makeRenderer(original, "original"),
      renderTranslation: makeRenderer(translated, "translation"),
      showLookup(word) {
        heading.textContent = word;
        result.hidden = true;
        meaning.textContent = "";
        sentence.textContent = "";
        status.hidden = false;
        status.textContent = message("wordLookupLoading");
        panel.hidden = false;
        layout();
        close.focus({preventScroll: true});
      },
      completeLookup({meaning: wordMeaning, sentenceMeaning, targetLanguage}) {
        if (panel.hidden) return;
        meaning.lang = targetLanguage;
        sentence.lang = targetLanguage;
        meaning.textContent = wordMeaning;
        sentence.textContent = sentenceMeaning;
        status.hidden = true;
        result.hidden = false;
      },
      failLookup() {
        if (panel.hidden) return;
        result.hidden = true;
        status.hidden = false;
        status.textContent = message("wordLookupUnavailable");
      },
      closeLookup: clearLookup,
      destroy() {
        stopDrag();
        resize.disconnect();
        for (const name of handleMouseEvents) window.removeEventListener(name, shieldHandle, true);
        root.removeEventListener("keydown", escapeLookup, true);
        panel.remove();
        handle.remove();
      }
    };
  };
})();
