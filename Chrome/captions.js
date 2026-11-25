(() => {
  "use strict";

  const origin = "https://www.youtube.com";
  const requestEvent = "online-subtitle-request-captions";
  const cancelEvent = "online-subtitle-cancel-captions";
  const responseEvent = "online-subtitle-captions";
  const maximumResponseBytes = 4 * 1024 * 1024;
  const maximumCues = 10_000;
  const videoIDPattern = /^[a-zA-Z0-9_-]{11}$/;
  const languagePattern = /^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/;
  const encoder = new TextEncoder();
  let activeRequest;

  function isCurrentVideo(videoId) {
    if (location.origin !== origin || location.pathname !== "/watch") return false;
    const videoIDs = new URLSearchParams(location.search).getAll("v");
    return videoIDs.length === 1 && videoIDs[0] === videoId;
  }

  function captionURL(value, videoId) {
    if (typeof value !== "string" || value.length > 8192) return;
    try {
      const url = new URL(value);
      const videoIDs = url.searchParams.getAll("v");
      if (url.origin !== origin || url.pathname !== "/api/timedtext" || url.username || url.password
          || url.hash || videoIDs.length !== 1 || videoIDs[0] !== videoId || url.searchParams.has("tlang")) return;
      url.searchParams.set("fmt", "json3");
      return url;
    } catch {
      return undefined;
    }
  }

  function runText(value) {
    if (typeof value?.simpleText === "string") return value.simpleText;
    if (!Array.isArray(value?.runs)) return "";
    return value.runs.slice(0, 64).map(run => typeof run?.text === "string" ? run.text : "").join("");
  }

  function makeCue(start, end, text) {
    const cleanText = text.replace(/\s+/gu, " ").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start
        || !cleanText || encoder.encode(cleanText).length > 1_000) return;
    return {start, end, text: cleanText};
  }

  function sortCues(cues) {
    return cues.filter(Boolean).sort((left, right) => left.start - right.start);
  }

  function timedTextCues(data) {
    if (!Array.isArray(data?.events)) return [];
    return sortCues(data.events.slice(0, maximumCues).map(event => {
      if (!Array.isArray(event?.segs) || event.segs.length > 64
          || typeof event.tStartMs !== "number" || typeof event.dDurationMs !== "number") return;
      const text = event.segs.map(segment => typeof segment?.utf8 === "string" ? segment.utf8 : "").join("");
      return makeCue(event.tStartMs / 1000, (event.tStartMs + event.dDurationMs) / 1000, text);
    }));
  }

  function playerResponse(player, videoId) {
    try {
      const response = player?.getPlayerResponse?.();
      if (response?.videoDetails?.videoId === videoId) return response;
    } catch {
      // The player can be replaced during watch-page navigation.
    }
    if (window.ytInitialPlayerResponse?.videoDetails?.videoId === videoId) {
      return window.ytInitialPlayerResponse;
    }
  }

  function viewerTranscriptMetadata(watchPage, videoId) {
    const watchData = watchPage?.data;
    const candidates = [watchData, watchData?.response, window.ytInitialData];
    for (const data of candidates) {
      if (data?.currentVideoEndpoint?.watchEndpoint?.videoId !== videoId
          || !Array.isArray(data.engagementPanels)) continue;
      const panels = data.engagementPanels.slice(0, 32).map(candidate => candidate?.engagementPanelSectionListRenderer);
      const panel = panels.find(candidate => candidate?.targetId === "engagement-panel-searchable-transcript"
        || candidate?.panelIdentifier === "engagement-panel-searchable-transcript");
      const description = panels.find(candidate => candidate?.targetId === "engagement-panel-structured-description");
      const items = description?.content?.structuredDescriptionContentRenderer?.items;
      const button = Array.isArray(items) && items.slice(0, 64).find(item => item?.videoDescriptionTranscriptSectionRenderer)
        ?.videoDescriptionTranscriptSectionRenderer?.primaryButton?.buttonRenderer;
      const commands = button?.command?.commandExecutorCommand?.commands;
      const modern = Array.isArray(commands) && commands.slice(0, 8)
        .map(command => command?.updateEngagementPanelContentCommand)
        .find(command => command?.contentSourcePanelIdentifier?.surface === "ENGAGEMENT_PANEL_SURFACE_WATCH"
          && command.contentSourcePanelIdentifier.tag === "PAmodern_transcript_view"
          && command.targetPanelIdentifier?.tag === "engagement-panel-timeline-view-consolidated");
      if (panel || modern) return {panel, modern};
    }
  }

  function getTracks(player, response, videoId) {
    const captionData = response?.captions?.playerCaptionsTracklistRenderer;
    let tracks = captionData?.captionTracks;
    if (!tracks?.length) {
      try {
        if (player?.getVideoData?.()?.video_id === videoId) {
          tracks = player.getOption?.("captions", "tracklist");
        }
      } catch {
        return [];
      }
    }
    if (!Array.isArray(tracks)) return [];
    const audioTrack = captionData?.audioTracks?.[captionData.defaultAudioTrackIndex ?? 0];
    const defaultCaption = audioTrack?.defaultCaptionTrackIndex ?? audioTrack?.captionTrackIndices?.[0];
    return tracks.slice(0, 64).flatMap((track, index) => {
      const trackLanguage = track?.languageCode;
      const url = captionURL(track?.baseUrl ?? track?.url, videoId);
      if (typeof trackLanguage !== "string" || trackLanguage.length > 40
          || !languagePattern.test(trackLanguage) || (track?.translationLanguage || track?.isTranslated)
          || (track?.baseUrl && !url)) return [];
      return [{
        language: trackLanguage,
        name: typeof track.name === "string" ? track.name : runText(track.name) || track.displayName || "",
        automatic: track.kind === "asr" || track.isAsr === true,
        preferredByPlayer: index === defaultCaption,
        url
      }];
    }).sort((left, right) => trackRank(left) - trackRank(right));
  }

  function trackRank(track) {
    if (/^en(?:-|$)/i.test(track.language)) return track.automatic ? 1 : 0;
    if (track.preferredByPlayer) return 2;
    return track.automatic ? 4 : 3;
  }

  async function readJSON(url, signal, options = {}) {
    try {
      const response = await fetch(url, {credentials: "same-origin", redirect: "error", signal, ...options});
      if (!response.ok || Number(response.headers.get("content-length")) > maximumResponseBytes
          || !response.body) return undefined;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let total = 0;
      let text = "";
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maximumResponseBytes) {
          await reader.cancel();
          return undefined;
        }
        text += decoder.decode(value, {stream: true});
      }
      text += decoder.decode();
      return text.trim() ? JSON.parse(text) : undefined;
    } catch {
      return undefined;
    }
  }

  function exposedCaptionURL(videoId, track) {
    const entries = performance.getEntriesByType("resource").slice(-150);
    for (const entry of entries.reverse()) {
      const url = captionURL(entry.name, videoId);
      if (url?.searchParams.get("lang")?.toLowerCase() === track.language.toLowerCase()
          && (url.searchParams.get("kind") === "asr") === track.automatic
          && url.href !== track.url?.href) return url;
    }
  }

  function transcriptRenderer(data) {
    if (!Array.isArray(data?.actions)) return;
    for (const action of data.actions.slice(0, 32)) {
      const command = action?.updateEngagementPanelAction;
      if (command?.targetId && command.targetId !== "engagement-panel-searchable-transcript") continue;
      const renderer = command?.content?.transcriptRenderer?.content?.transcriptSearchPanelRenderer;
      if (renderer) return renderer;
    }
  }

  function transcriptCues(renderer) {
    const segments = renderer?.body?.transcriptSegmentListRenderer?.initialSegments;
    if (!Array.isArray(segments)) return [];
    return sortCues(segments.slice(0, maximumCues).map(item => {
      const segment = item?.transcriptSegmentRenderer;
      if (!segment) return;
      return makeCue(secondsFromMilliseconds(segment.startMs), secondsFromMilliseconds(segment.endMs), runText(segment.snippet));
    }));
  }

  function secondsFromMilliseconds(value) {
    return typeof value === "string" && /^\d{1,12}$/.test(value) ? Number(value) / 1000 : NaN;
  }

  function modernTranscriptCues(data, videoId) {
    const panel = data?.content?.engagementPanelSectionListRenderer;
    if (panel?.identifier?.tag !== "PAmodern_transcript_view") return [];
    const contents = panel?.content?.sectionListRenderer?.contents;
    const mutations = data?.frameworkUpdates?.entityBatchUpdate?.mutations;
    if (!Array.isArray(contents) || !Array.isArray(mutations)) return [];
    const timing = mutations.slice(0, 32).find(mutation => mutation?.payload?.timedMarkersListSyncEntity)
      ?.payload?.timedMarkersListSyncEntity?.timedListData?.sections;
    if (!Array.isArray(timing)) return [];

    // YouTube includes a timing entry for each section heading as well as for each caption.
    const timingEntries = [];
    for (const section of timing.slice(0, maximumCues)) {
      if (!Array.isArray(section?.timedSyncDataList)) return [];
      timingEntries.push(...section.timedSyncDataList.slice(0, maximumCues - timingEntries.length));
      if (timingEntries.length === maximumCues) break;
    }

    const cues = [];
    let remaining = maximumCues;
    for (const section of contents.slice(0, maximumCues)) {
      const items = section?.itemSectionRenderer?.contents;
      if (!Array.isArray(items)) continue;
      for (const item of items.slice(0, remaining)) {
        remaining -= 1;
        const marker = item?.macroMarkersPanelItemViewModel;
        if (marker?.panelId !== "PAmodern_transcript_view"
            || !Number.isInteger(marker.index) || marker.index < 0 || marker.index >= timingEntries.length) continue;
        const target = marker?.onTap?.innertubeCommand?.watchEndpoint;
        if (target?.videoId !== videoId || !Number.isFinite(target.startTimeSeconds)) continue;
        const segment = marker?.item?.timelineItemViewModel?.contentItems?.[0]?.transcriptSegmentViewModel;
        if (typeof segment?.simpleText !== "string") continue;
        const entry = timingEntries[marker.index];
        const start = secondsFromMilliseconds(entry?.videoTimeMs);
        if (Math.abs(start - target.startTimeSeconds) >= 1) continue;
        const cue = makeCue(start, secondsFromMilliseconds(entry?.endTimeMs), segment.simpleText);
        if (cue) cues.push(cue);
      }
      if (!remaining) break;
    }
    return sortCues(cues);
  }

  function transcriptCommands(renderer) {
    const items = renderer?.footer?.transcriptFooterRenderer?.languageMenu?.sortFilterSubMenuRenderer?.subMenuItems;
    return Array.isArray(items) ? items.slice(0, 64) : [];
  }

  function validParams(params) {
    return typeof params === "string" && /^[A-Za-z0-9_+/%=-]{1,4096}$/.test(params);
  }

  async function viewerRequest(path, request, signal) {
    const context = window.ytcfg?.get?.("INNERTUBE_CONTEXT");
    if (!context?.client || !validParams(request.params)) return;
    const headers = {"Content-Type": "application/json"};
    const version = context.client.clientVersion;
    if (typeof version === "string" && /^[0-9.]{1,48}$/.test(version)) {
      headers["X-YouTube-Client-Name"] = "1";
      headers["X-YouTube-Client-Version"] = version;
    }
    const visitorData = context.client.visitorData;
    if (typeof visitorData === "string" && /^[A-Za-z0-9_+/%=-]{1,512}$/.test(visitorData)) {
      headers["X-Goog-Visitor-Id"] = visitorData;
    }
    return readJSON(
      origin + path + "?prettyPrint=false",
      signal,
      {method: "POST", headers, body: JSON.stringify({context: {client: context.client}, ...request})}
    );
  }

  async function transcriptResponse(command, signal) {
    const path = command?.commandMetadata?.webCommandMetadata?.apiUrl;
    if (path !== undefined && path !== "/youtubei/v1/get_transcript") return;
    return transcriptRenderer(await viewerRequest("/youtubei/v1/get_transcript", {
      params: command?.getTranscriptEndpoint?.params
    }, signal));
  }

  function resultFor(cues, track) {
    return {cues, track};
  }

  async function extractFromTranscript(metadata, tracks, videoId, signal) {
    if (!metadata || !tracks.length) return;
    const {panel, modern} = metadata;
    const preferred = tracks[0];
    const modernTrack = tracks.find(track => track.preferredByPlayer) ?? (tracks.length === 1 ? tracks[0] : undefined);
    let modernResult;
    if (modern && modernTrack) {
      const result = await viewerRequest("/youtubei/v1/get_panel", {
        panelId: "PAmodern_transcript_view",
        params: modern.globalConfiguration?.params
      }, signal);
      const cues = modernTranscriptCues(result, videoId);
      if (cues.length) {
        modernResult = resultFor(cues, modernTrack);
        if (modernTrack === preferred) return modernResult;
      }
    }
    if (!panel || signal.aborted) return modernResult;
    const command = panel?.content?.continuationItemRenderer?.continuationEndpoint;
    let renderer = panel?.content?.transcriptRenderer?.content?.transcriptSearchPanelRenderer;
    if (!renderer) renderer = await transcriptResponse(command, signal);
    if (!renderer || signal.aborted) return modernResult;
    const items = transcriptCommands(renderer);
    const preferredItem = items.find(item => preferred.name && item?.title === preferred.name);
    if (preferredItem && !preferredItem.selected && preferredItem.continuation) {
      const chosenRenderer = await transcriptResponse(preferredItem.continuation, signal);
      const chosenCues = transcriptCues(chosenRenderer);
      if (chosenCues.length) return resultFor(chosenCues, preferred);
    }
    const selected = items.find(item => item?.selected);
    const track = tracks.find(track => track.name && track.name === selected?.title)
      ?? (tracks.length === 1 ? preferred : tracks.find(track => track.preferredByPlayer));
    if (!track || (modernResult && trackRank(modernResult.track) <= trackRank(track))) return modernResult;
    const cues = transcriptCues(renderer);
    if (cues.length) return resultFor(cues, track);
    return modernResult;
  }

  async function extract(videoId, signal) {
    // Watch navigation can replace the player before publishing the new video's track list.
    let tracks = [];
    let metadata;
    for (let attempt = 0; attempt < 24 && isCurrentVideo(videoId) && !signal.aborted; attempt += 1) {
      const player = document.getElementById("movie_player");
      const watchPage = document.querySelector("ytd-watch-flexy");
      const response = playerResponse(player, videoId);
      tracks = getTracks(player, response, videoId);
      const initial = window.ytInitialPlayerResponse;
      if (!tracks.length && initial !== response && initial?.videoDetails?.videoId === videoId) {
        tracks = getTracks(undefined, initial, videoId);
      }
      metadata = viewerTranscriptMetadata(watchPage, videoId);
      if (tracks.length && (metadata || attempt >= 4)) break;
      if (response?.playabilityStatus?.status === "OK" && !response.captions && attempt >= 8) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }

    // Try the preferred original track before falling back to the native transcript or another track.
    let transcriptFallback;
    for (const [index, track] of tracks.slice(0, 3).entries()) {
      if (!isCurrentVideo(videoId)) return;
      if (signal.aborted || (transcriptFallback && trackRank(transcriptFallback.track) < trackRank(track))) break;
      const url = exposedCaptionURL(videoId, track) ?? track.url;
      if (url) {
        const cues = timedTextCues(await readJSON(url, AbortSignal.any([signal, AbortSignal.timeout(3000)])));
        if (cues.length) return resultFor(cues, track);
      }
      if (index === 0 && isCurrentVideo(videoId) && !signal.aborted) {
        // The player can publish a track URL before the watch page is ready with a transcript command.
        for (let attempt = 0; !metadata && attempt < 8 && !signal.aborted && isCurrentVideo(videoId); attempt += 1) {
          metadata = viewerTranscriptMetadata(document.querySelector("ytd-watch-flexy"), videoId);
          if (!metadata) await new Promise(resolve => setTimeout(resolve, 150));
        }
        if (!isCurrentVideo(videoId) || signal.aborted) return;
        transcriptFallback = await extractFromTranscript(
          metadata, tracks, videoId, AbortSignal.any([signal, AbortSignal.timeout(4500)])
        );
        if (transcriptFallback?.track === track) return transcriptFallback;
      }
    }
    return transcriptFallback;
  }

  function validID(id) {
    return (Number.isSafeInteger(id) && id >= 0)
      || (typeof id === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(id));
  }

  function cancelActiveRequest() {
    const request = activeRequest;
    activeRequest = undefined;
    request?.controller.abort();
  }

  document.addEventListener(requestEvent, async event => {
    const {id, videoId} = event.detail ?? {};
    if (!validID(id) || typeof videoId !== "string" || !videoIDPattern.test(videoId) || !isCurrentVideo(videoId)) return;
    cancelActiveRequest();
    const request = {id, videoId, controller: new AbortController()};
    activeRequest = request;
    let result;
    try {
      result = await extract(videoId, AbortSignal.any([request.controller.signal, AbortSignal.timeout(15_000)]));
    } catch {
      // YouTube's internal caption shapes are optional and can change independently.
    }
    if (request.controller.signal.aborted || activeRequest !== request || !isCurrentVideo(videoId)) return;
    activeRequest = undefined;
    const captions = result
      ? {cues: result.cues, sourceLanguage: result.track.language}
      : {cues: [], sourceLanguage: "", error: "captions-unavailable"};
    document.dispatchEvent(new CustomEvent(responseEvent, {
      detail: {id, videoId, ...captions}
    }));
  });

  document.addEventListener(cancelEvent, event => {
    const {id, videoId} = event.detail ?? {};
    if (location.origin === origin && activeRequest && activeRequest.id === id && activeRequest.videoId === videoId) {
      cancelActiveRequest();
    }
  });
  document.addEventListener("yt-navigate-start", cancelActiveRequest);
})();
