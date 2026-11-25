(() => {
  "use strict";

  const edge = 10;
  const minimumLookupSpace = 120;
  const closingPunctuation = /^[\p{Pe}\p{Pf}\p{Terminal_Punctuation}"'%…]+$/u;
  const captionMouseEvents = ["mousedown", "mouseup", "click", "dblclick"];
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

  globalThis.onlineSubtitleCreateInteractions = function createInteractions({player, root, stack, original, onWord, onDismiss, message}) {
    stack.tabIndex = 0;
    stack.setAttribute("role", "group");
    stack.setAttribute("aria-label", message("moveSubtitles"));
    stack.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown");
    const wordActions = new WeakMap();

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
    const result = element("p", "online-subtitle-lookup-result");
    result.setAttribute("aria-live", "polite");
    result.dir = "auto";
    panel.append(header, status, result);
    root.append(panel);

    let drag;
    let focusReturn;
    let displayedText;
    let displayedLanguage;
    let segmenter;

    function captionRange() {
      const reserve = Math.min(68, root.clientHeight * 0.17);
      const max = Math.max(0, root.clientHeight - stack.offsetHeight - edge);
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
      stack.removeAttribute("data-online-subtitle-dragging");
      if (releaseCapture && stack.hasPointerCapture(pointerId)) stack.releasePointerCapture(pointerId);
    }

    function beginDrag(event) {
      const path = event.composedPath();
      if (!path.includes(stack)) return;
      event.stopPropagation();
      if (!event.isTrusted || !event.isPrimary || event.button !== 0 || !Number.isFinite(event.clientY) ||
        drag || stack.hidden || path.some(node => wordActions.has(node))) return;
      event.preventDefault();
      stack.setPointerCapture(event.pointerId);
      drag = {pointerId: event.pointerId, startY: event.clientY, bottom: captionBottom()};
      stack.setAttribute("data-online-subtitle-dragging", "");
      stack.focus({preventScroll: true});
    }
    function dragCaption(event) {
      if (!event.isTrusted || event.pointerId !== drag?.pointerId || !Number.isFinite(event.clientY)) return;
      event.stopPropagation();
      moveCaption(drag.bottom + drag.startY - event.clientY);
    }
    function endDrag(event) {
      if (!event.isTrusted || event.pointerId !== drag?.pointerId) return;
      event.stopPropagation();
      // Let the browser release capture after pointerup so its click is
      // still targeted at the caption even if the pointer left its bounds.
      stopDrag(false);
    }

    function handleCaptionMouse(event) {
      const path = event.composedPath();
      if (!path.includes(stack)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "click" && event.isTrusted && !stack.hidden) {
        const word = path.find(node => wordActions.has(node));
        if (word?.isConnected) wordActions.get(word)();
      }
    }
    // Route caption-owned gestures before the player sees them, including
    // the compatibility mouse events generated for a pointer gesture.
    const gestures = {pointerdown: beginDrag, pointermove: dragCaption,
      pointerup: endDrag, pointercancel: endDrag, lostpointercapture: endDrag};
    for (const name of captionMouseEvents) gestures[name] = handleCaptionMouse;
    for (const [name, listener] of Object.entries(gestures)) window.addEventListener(name, listener, true);
    stack.addEventListener("keydown", event => {
      if (!event.isTrusted || event.target !== stack || !["ArrowUp", "ArrowDown", "Enter", " "].includes(event.key)) return;
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
      result.textContent = "";
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

    return {
      renderSource(text, language) {
        if (displayedText === text && displayedLanguage === language) return;
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
          word.addEventListener("keydown", event => event.stopPropagation());
          wordActions.set(word, () => {
            heading.lang = language || "";
            onWord(segment);
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
        original.replaceChildren(parts);
      },
      showLookup(word) {
        heading.textContent = word;
        result.hidden = true;
        result.textContent = "";
        status.hidden = false;
        status.textContent = message("wordLookupLoading");
        panel.hidden = false;
        layout();
        close.focus({preventScroll: true});
      },
      completeLookup({meaning, targetLanguage}) {
        if (panel.hidden) return;
        result.lang = targetLanguage;
        result.textContent = meaning;
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
        for (const [name, listener] of Object.entries(gestures)) window.removeEventListener(name, listener, true);
        root.removeEventListener("keydown", escapeLookup, true);
        panel.remove();
      }
    };
  };
})();
