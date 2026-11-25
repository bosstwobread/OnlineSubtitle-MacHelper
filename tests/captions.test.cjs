const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const captionScript = fs.readFileSync(path.join(__dirname, "../Chrome/captions.js"), "utf8");
const videoId = "6CG9MEEPX2s";
const nextVideoId = "jNQXAC9IVRw";
const origin = "https://www.youtube.com";
const transcriptPanelID = "engagement-panel-searchable-transcript";

function track(languageCode, name, {kind, url} = {}) {
  return {
    languageCode,
    name: {simpleText: name},
    kind,
    baseUrl: url ?? `${origin}/api/timedtext?v=${videoId}&lang=${languageCode}${kind ? "&kind=" + kind : ""}`
  };
}

function transcriptCommand(params) {
  return {
    commandMetadata: {webCommandMetadata: {apiUrl: "/youtubei/v1/get_transcript"}},
    getTranscriptEndpoint: {params}
  };
}

function transcriptResult(text, items) {
  const content = {transcriptRenderer: {content: {transcriptSearchPanelRenderer: {
    body: {transcriptSegmentListRenderer: {initialSegments: [
      {transcriptSegmentRenderer: {startMs: "1000", endMs: "3000", snippet: {runs: [{text}]}}}
    ]}},
    footer: {transcriptFooterRenderer: {languageMenu: {sortFilterSubMenuRenderer: {subMenuItems: items}}}}
  }}}};
  return {actions: [{updateEngagementPanelAction: {targetId: transcriptPanelID, content}}]};
}

function playerMetadata(videoId, tracks, captionIndex, audioTracks = [{captionTrackIndices: [captionIndex]}], defaultAudioTrackIndex = 0) {
  const response = {
    videoDetails: {videoId},
    playabilityStatus: {status: "OK"}
  };
  if (tracks) {
    response.captions = {
      playerCaptionsTracklistRenderer: {
        captionTracks: tracks,
        audioTracks,
        defaultAudioTrackIndex
      }
    };
  }
  return response;
}

function fixture({
  tracks, captionIndex, playerVideo = videoId, initialPlayerResponse, initialDataVideo = videoId,
  optionTracks, audioTracks, defaultAudioTrackIndex, resourceURLs = [], modern = false, fetch
}) {
  const document = new EventTarget();
  const location = new URL(`${origin}/watch?v=${videoId}`);
  const playerResponse = playerMetadata(playerVideo, tracks, captionIndex, audioTracks, defaultAudioTrackIndex);
  const page = {
    currentVideoEndpoint: {watchEndpoint: {videoId: initialDataVideo}},
    engagementPanels: [{engagementPanelSectionListRenderer: {
      targetId: transcriptPanelID,
      content: {continuationItemRenderer: {continuationEndpoint: transcriptCommand("initial")}}
    }}]
  };
  if (modern) {
    const command = {updateEngagementPanelContentCommand: {
      targetPanelIdentifier: {tag: "engagement-panel-timeline-view-consolidated"},
      contentSourcePanelIdentifier: {surface: "ENGAGEMENT_PANEL_SURFACE_WATCH", tag: "PAmodern_transcript_view"},
      globalConfiguration: {params: "current-video-panel"}
    }};
    const primaryButton = {buttonRenderer: {command: {commandExecutorCommand: {commands: [command]}}}};
    page.engagementPanels.push({engagementPanelSectionListRenderer: {
      targetId: "engagement-panel-structured-description",
      content: {structuredDescriptionContentRenderer: {items: [
        {videoDescriptionTranscriptSectionRenderer: {primaryButton}}
      ]}}
    }});
  }
  document.getElementById = () => ({
    getPlayerResponse: () => playerResponse,
    getVideoData: () => ({video_id: playerVideo}),
    getOption: () => optionTracks
  });
  document.querySelector = () => ({data: page});
  vm.runInNewContext(captionScript, {
    document, location, fetch, URL, URLSearchParams, AbortSignal, AbortController, CustomEvent, setTimeout,
    TextEncoder, TextDecoder, performance: {getEntriesByType: () => resourceURLs.map(name => ({name}))},
    window: {
      ytInitialPlayerResponse: initialPlayerResponse,
      ytcfg: {get: () => ({client: {clientName: "WEB", clientVersion: "2.20261125"}})}
    }
  });
  function request(id = 1) {
    document.dispatchEvent(new CustomEvent("online-subtitle-request-captions", {detail: JSON.stringify({id, videoId})}));
  }
  function requestResult() {
    return new Promise(resolve => {
      document.addEventListener("online-subtitle-captions", event => {
        resolve(JSON.parse(event.detail));
      }, {once: true});
      request();
    });
  }
  return {document, location, request, requestResult};
}

test("prefers manual English and returns valid sorted cue timing", async () => {
  const requested = [];
  const harness = fixture({
    tracks: [track("en", "English (automatic)", {kind: "asr"}), track("en-US", "English (United States)")],
    initialPlayerResponse: playerMetadata(videoId, [track("en-GB", "English (United Kingdom)")]),
    fetch: async url => {
      requested.push(url.href);
      return Response.json({events: [
        {tStartMs: 3000, dDurationMs: 1000, segs: [{utf8: "Next."}]},
        {tStartMs: 1000, dDurationMs: 1990, segs: [{utf8: " First "}, {utf8: "\n line. "}]},
        {tStartMs: 1500, dDurationMs: 0, segs: [{utf8: "Ignore."}]},
        {tStartMs: 5500, dDurationMs: 1000, segs: [{utf8: "字".repeat(400)}]}
      ]});
    }
  });
  assert.deepEqual(requested, []);
  assert.deepEqual(await harness.requestResult(), {
    id: 1, videoId, sourceLanguage: "en-US", cues: [
      {start: 1, end: 2.99, text: "First line."},
      {start: 3, end: 4, text: "Next."}
    ]
  });
  assert.equal(requested.length, 1);
  assert.equal(new URL(requested[0]).searchParams.get("fmt"), "json3");
  assert.equal(new URL(requested[0]).searchParams.get("lang"), "en-US");
});

test("uses the default audio's own caption language before an available English track", async () => {
  const requested = [];
  const harness = fixture({
    tracks: [track("en", "English"), track("ja", "日本語（自動生成）", {kind: "asr"}), track("ja-JP", "日本語")],
    audioTracks: [
      {audioTrackId: "en.4", captionTrackIndices: [0], defaultCaptionTrackIndex: 0},
      {audioTrackId: "ja.4", captionTrackIndices: [0, 1, 2], defaultCaptionTrackIndex: 0}
    ],
    defaultAudioTrackIndex: 1,
    fetch: async url => {
      requested.push(url.searchParams.get("lang"));
      return Response.json({events: [{tStartMs: 0, dDurationMs: 1000, segs: [{utf8: "今日は晴れです。"}]}]});
    }
  });
  assert.equal((await harness.requestResult()).sourceLanguage, "ja-JP");
  assert.deepEqual(requested, ["ja-JP"]);
});

test("prefers speech recognition in the audio's language over authored captions in another language", async () => {
  const requested = [];
  const harness = fixture({
    tracks: [track("en", "English"), track("es-419", "Español (automático)", {kind: "asr"})],
    audioTracks: [{captionTrackIndices: [0, 1], defaultCaptionTrackIndex: 0}],
    fetch: async url => {
      requested.push(url.searchParams.get("lang"));
      return Response.json({events: [{tStartMs: 0, dDurationMs: 1000, segs: [{utf8: "¿Cómo estás?"}]}]});
    }
  });
  assert.deepEqual(await harness.requestResult(), {
    id: 1, videoId, sourceLanguage: "es-419", cues: [{start: 0, end: 1, text: "¿Cómo estás?"}]
  });
  assert.deepEqual(requested, ["es-419"]);
});

test("uses the watch video's initial track while the player reports an ad video ID", async () => {
  const requests = [];
  const harness = fixture({
    playerVideo: nextVideoId,
    tracks: [track("en", "Advertisement", {url: `${origin}/api/timedtext?v=${nextVideoId}&lang=en`})],
    initialPlayerResponse: playerMetadata(videoId, [track("fr", "French")]),
    fetch: async url => {
      requests.push(url.href);
      return Response.json({events: [{tStartMs: 0, dDurationMs: 1000, segs: [{utf8: "Bonjour."}]}]});
    }
  });
  assert.deepEqual(await harness.requestResult(), {
    id: 1, videoId, sourceLanguage: "fr", cues: [{start: 0, end: 1, text: "Bonjour."}]
  });
  assert.deepEqual(requests, [`${origin}/api/timedtext?v=${videoId}&lang=fr&fmt=json3`]);
});

test("an incomplete same-video live response falls back to ranked initial tracks", async () => {
  const requests = [];
  const harness = fixture({
    initialPlayerResponse: playerMetadata(videoId, [
      track("en", "English (automatic)", {kind: "asr"}), track("en-US", "English (United States)")
    ]),
    fetch: async url => {
      requests.push(url.href);
      return Response.json({events: [{tStartMs: 0, dDurationMs: 1000, segs: [{utf8: "Watch cue."}]}]});
    }
  });
  assert.deepEqual(await harness.requestResult(), {
    id: 1, videoId, sourceLanguage: "en-US", cues: [{start: 0, end: 1, text: "Watch cue."}]
  });
  assert.deepEqual(requests, [`${origin}/api/timedtext?v=${videoId}&lang=en-US&fmt=json3`]);
});

test("prefers usable current player options over matching initial tracks", async () => {
  const requests = [];
  const harness = fixture({
    optionTracks: [track("fr", "French")],
    initialPlayerResponse: playerMetadata(videoId, [track("en", "English")]),
    fetch: async url => {
      requests.push(url.href);
      return Response.json({events: [{tStartMs: 0, dDurationMs: 1000, segs: [{utf8: "Bonjour."}]}]});
    }
  });
  const result = await harness.requestResult();
  assert.equal(result.sourceLanguage, "fr");
  assert.deepEqual(requests, [`${origin}/api/timedtext?v=${videoId}&lang=fr&fmt=json3`]);
});

test("rejects initial tracks associated with an ad when the exact live response is incomplete", async () => {
  const requests = [];
  const harness = fixture({
    initialPlayerResponse: playerMetadata(nextVideoId, [track("en", "Mismatched initial player data")]),
    fetch: async url => {
      requests.push(String(url));
      return new Response("");
    }
  });
  assert.deepEqual(await harness.requestResult(), {
    id: 1, videoId, sourceLanguage: "", cues: [], error: "captions-unavailable"
  });
  assert.deepEqual(requests, []);
});

test("falls back to the matching viewer transcript when timed text is empty", async () => {
  const requests = [];
  const harness = fixture({
    tracks: [track("en", "English (automatic)", {kind: "asr"}), track("en-US", "English (United States)")],
    fetch: async (url, options) => {
      requests.push({url: String(url), method: options.method, body: options.body});
      if (!options.method) return new Response("");
      const {params} = JSON.parse(options.body);
      if (params === "initial") return Response.json(transcriptResult("Automatic captions", [
        {title: "English (automatic)", selected: true},
        {title: "English (United States)", selected: false, continuation: transcriptCommand("manual")}
      ]));
      if (params === "manual") return Response.json(transcriptResult("Manual caption", []));
      throw new Error("Unexpected transcript query");
    }
  });
  assert.deepEqual(await harness.requestResult(), {
    id: 1, videoId, sourceLanguage: "en-US", cues: [{start: 1, end: 3, text: "Manual caption"}]
  });
  assert.equal(requests.length, 3);
  for (const request of requests.slice(1)) assert.equal(request.url, origin + "/youtubei/v1/get_transcript?prettyPrint=false");
});

test("uses the newer viewer transcript with its exact indexed timing and current video", async () => {
  const requests = [];
  function item(index, startTimeSeconds, text, targetVideo = videoId) {
    return {macroMarkersPanelItemViewModel: {
      panelId: "PAmodern_transcript_view",
      index,
      onTap: {innertubeCommand: {watchEndpoint: {videoId: targetVideo, startTimeSeconds}}},
      item: {timelineItemViewModel: {contentItems: [{transcriptSegmentViewModel: {simpleText: text}}]}}
    }};
  }
  const result = {
    content: {engagementPanelSectionListRenderer: {
      identifier: {tag: "PAmodern_transcript_view"},
      content: {sectionListRenderer: {contents: [
        {itemSectionRenderer: {contents: [item(1, 0, "First line. ")]}},
        {itemSectionRenderer: {contents: [item(3, 62, " Second line."), item(4, 65, "Stale.", nextVideoId)]}}
      ]}}
    }},
    frameworkUpdates: {entityBatchUpdate: {mutations: [{payload: {
      timedMarkersListSyncEntity: {timedListData: {sections: [
        {timedSyncDataList: [{videoTimeMs: "0"}, {videoTimeMs: "0", endTimeMs: "5330"}]},
        {timedSyncDataList: [
          {videoTimeMs: "62000"}, {videoTimeMs: "62300", endTimeMs: "65080"}, {videoTimeMs: "65000", endTimeMs: "67600"}
        ]}
      ]}}
    }}]}}
  };
  const harness = fixture({
    tracks: [track("en", "English (automatic)", {kind: "asr"}), track("en-US", "English (United States)")],
    captionIndex: 1,
    modern: true,
    fetch: async (url, options) => {
      requests.push(String(url));
      if (!options.method) return new Response("");
      assert.deepEqual(JSON.parse(options.body), {
        context: {client: {clientName: "WEB", clientVersion: "2.20261125"}},
        panelId: "PAmodern_transcript_view",
        params: "current-video-panel"
      });
      return Response.json(result);
    }
  });
  assert.deepEqual(await harness.requestResult(), {
    id: 1, videoId, sourceLanguage: "en-US", cues: [
      {start: 0, end: 5.33, text: "First line."}, {start: 62.3, end: 65.08, text: "Second line."}
    ]
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1], origin + "/youtubei/v1/get_panel?prettyPrint=false");
});

test("uses the current video's exposed native timed-text URL and rejects other origins and IDs", async () => {
  const requests = [];
  const harness = fixture({
    tracks: [
      track("en-US", "English", {url: `https://example.com/api/timedtext?v=${videoId}`}),
      track("fr", "French")
    ],
    resourceURLs: [
      `${origin}/api/timedtext?lang=fr&v=${videoId}&proof=session`,
      `${origin}/api/timedtext?lang=fr&v=${videoId}&tlang=en`,
      `${origin}/api/timedtext?lang=fr&v=${nextVideoId}`
    ],
    fetch: async (url, options) => {
      assert.equal(options.redirect, "error");
      assert.equal(options.credentials, "same-origin");
      requests.push(url.href);
      return Response.json({events: [{tStartMs: 0, dDurationMs: 1200, segs: [{utf8: "Bonjour."}]}]});
    }
  });
  assert.deepEqual(await harness.requestResult(), {
    id: 1, videoId, sourceLanguage: "fr", cues: [{start: 0, end: 1.2, text: "Bonjour."}]
  });
  assert.deepEqual(requests, [`${origin}/api/timedtext?lang=fr&v=${videoId}&proof=session&fmt=json3`]);
});

test("does not use transcript metadata left behind by another video", async () => {
  const requests = [];
  const harness = fixture({
    tracks: [track("en", "English")],
    initialDataVideo: nextVideoId,
    fetch: async url => {
      requests.push(String(url));
      return new Response("");
    }
  });
  assert.deepEqual(await harness.requestResult(), {
    id: 1, videoId, sourceLanguage: "", cues: [], error: "captions-unavailable"
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0], /\/api\/timedtext/);
});

test("aborts extraction on watch-page navigation and discards the old result", async () => {
  let requested;
  const harness = fixture({
    tracks: [track("en", "English")],
    fetch: async (_url, {signal}) => {
      requested = signal;
      return new Promise(resolve => signal.addEventListener("abort", () => resolve(Response.json({
        events: [{tStartMs: 0, dDurationMs: 1200, segs: [{utf8: "Old cue."}]}]
      })), {once: true}));
    }
  });
  let responses = 0;
  harness.document.addEventListener("online-subtitle-captions", () => { responses += 1; });
  harness.request();
  assert.ok(requested);
  harness.document.dispatchEvent(new Event("yt-navigate-start"));
  harness.location.search = `?v=${nextVideoId}`;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requested.aborted, true);
  assert.equal(responses, 0);
});

test("cancels only the matching pending caption request and allows a fresh request", async () => {
  const fetches = [];
  const harness = fixture({
    tracks: [track("en", "English")],
    fetch: async (_url, {signal}) => new Promise(resolve => {
      const complete = () => resolve(Response.json({
        events: [{tStartMs: 0, dDurationMs: 1200, segs: [{utf8: "Test cue."}]}]
      }));
      fetches.push({signal, complete});
      signal.addEventListener("abort", complete, {once: true});
    })
  });
  function cancel(id, currentVideoId = videoId) {
    harness.document.dispatchEvent(new CustomEvent("online-subtitle-cancel-captions", {
      detail: JSON.stringify({id, videoId: currentVideoId})
    }));
  }
  const responses = [];
  harness.document.addEventListener("online-subtitle-captions", event => responses.push(JSON.parse(event.detail).id));
  harness.request(12);
  cancel(99);
  cancel(12, nextVideoId);
  assert.equal(fetches[0].signal.aborted, false);
  // The isolated script may observe a new watch URL before YouTube emits a navigation event.
  harness.location.search = `?v=${nextVideoId}`;
  cancel(12);
  assert.equal(fetches[0].signal.aborted, true);
  harness.location.search = `?v=${videoId}`;
  harness.request(13);
  cancel(12);
  assert.equal(fetches[1].signal.aborted, false);
  fetches[1].complete();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(responses, [13]);
});
