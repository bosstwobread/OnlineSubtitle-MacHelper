# OnlineSubtitle

A MacHelper source extension and Chrome companion that display bilingual captions on YouTube watch pages. The original captions appear as soon as they are available. Simplified Chinese appears cue by cue above the player controls. OnlineSubtitle tries manually authored English first, then uses captions or the transcript available to the current viewer. Other source languages can also be translated. There is no settings screen in this version.

## Set up locally

You need macOS 14 or later, [MacHelper](https://github.com/bosstwobread/LocalAIBaseTools), Google Chrome, Ollama, and Xcode Command Line Tools.

1. In MacHelper 6.2 or later, open **Extensions → Install Source…**, choose the [MacHelperExtension](MacHelperExtension/) folder, and enable **OnlineSubtitle** after reviewing native code access.
2. Start Ollama with a downloaded chat model. This prototype uses the standard local Ollama address and a version that supports the `:local` model suffix and structured output. It prefers a locally installed Qwen model, then chooses the smallest eligible model in its preferred group.
3. From the project directory run `./scripts/register-chrome-host.sh`. It builds and registers the caption-only native messaging helper for your user.
4. Open `chrome://extensions` in Chrome 116 or later, enable **Developer mode**, and use **Load unpacked** to choose the [Chrome](Chrome/) folder. Reload an open YouTube watch page. If you use Language Reactor at the same time, switch it off for that video to avoid overlapping captions.

The unpacked Chrome companion requires one-time user installation. MacHelper must be running with OnlineSubtitle enabled. Source captions can still display if translation is unavailable. Reload the watch page after making Ollama or MacHelper available.

## How it works

```mermaid
flowchart LR
    YT["YouTube timed captions"]
    EX["Chrome caption reader"]
    UI["Chrome player overlay"]
    SW["Chrome service worker"]
    BR["Swift native messaging bridge"]
    MH["MacHelper Swift worker"]
    AI["Ollama on 127.0.0.1:11434"]

    YT --> EX --> UI
    UI <-->|"Cue IDs and text"| SW
    SW <-->|"Chrome Native Messaging"| BR
    BR <-->|"Per-user Unix socket"| MH
    MH <-->|"Local HTTP"| AI
```

1. **Read the source captions.** The Manifest V3 companion injects a [reader](Chrome/captions.js) into the YouTube page’s JavaScript world and a [controller](Chrome/content.js) into Chrome’s isolated world. The reader checks the active video ID, ranks the available tracks, and tries the existing timed-text track. It can also read YouTube’s transcript panel data when the timed-text response is empty. Both routes produce cues with start and end times and source text. One DOM event delivers the result for the current video to the controller. Caption acquisition uses the viewer’s YouTube session in Chrome and depends on YouTube’s internal response formats.
2. **Synchronize and schedule.** The [overlay](Chrome/subtitles.css) is positioned inside the player above the controls. The controller uses the video’s actual playback time to select a cue and renders the source text immediately. It translates up to three cues for the first batch, then up to eight at a time, favoring the current line and the next 24 seconds. Seeking can cancel a batch that is too far from the new position. Ads and background tabs suspend new translation batches. The current tab keeps completed translations in memory, so playing a translated cue again can reuse its result.
3. **Send a narrow request to the Mac.** The [service worker](Chrome/background.js) accepts the request from the companion’s top frame on a valid YouTube watch URL. A request contains numeric cue IDs and caption text. Chrome launches the [Swift bridge](NativeHost/main.swift) through Native Messaging. The bridge accepts the exact installed companion origin, checks the request and reply, and forwards a single batch to a Unix socket in a user-owned directory with mode `0700`. Frames are length-prefixed JSON with a 32 KiB ceiling. The bridge closes the worker connection if the browser disconnects.
4. **Translate locally and match the reply.** MacHelper compiles the [worker](MacHelperExtension/Main.swift) with its native extension SDK and starts it after approval. The worker queries Ollama’s `/api/tags` on loopback and requests structured Simplified Chinese translations from `/api/chat`. It selects an eligible local model, preferring Qwen, and explicitly requests local execution using the `:local` suffix. The model receives a fixed translation prompt and the cue batch as separate data. The worker rejects incomplete or mismatched replies, and the controller displays each translation under its original cue based on the cue ID.

OnlineSubtitle keeps its caption and translation cache in memory. Translation requests go to local Ollama, and the finished subtitle text is rendered in the YouTube player’s shared DOM. Browser authentication stays in Chrome. The worker runs with the macOS user’s permissions after native execution approval. The source text can appear while the translation is pending or unavailable. Videos without an accessible caption track or transcript are outside the current scope, as are live transcription and speech recognition.

## Develop and verify

- Run `node --test tests/*.test.cjs` on macOS with Node.js 20.3 or later and Xcode Command Line Tools. The tests cover caption parsing, playback scheduling, Chrome’s native bridge, and the Swift worker, using synthetic fixtures by default.
- Clone [LocalAIBaseTools](https://github.com/bosstwobread/LocalAIBaseTools) next to this repository for the test SDK. Set `MACHELPER_NATIVE_SDK` to the path of `MacHelperNativeSDK.swift` if your checkout is elsewhere. MacHelper supplies its own SDK when it compiles an installed extension.
- Add `ONLINE_SUBTITLE_TEST_LIVE=1` when running `tests/worker.test.cjs` to translate two synthetic cues through your local Ollama instead of the test server.
- After changing browser files, reload the unpacked Chrome companion and the test watch page. Use **Edit Source** in MacHelper when editing an installed copy of the Swift worker.
