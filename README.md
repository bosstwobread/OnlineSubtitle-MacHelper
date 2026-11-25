# OnlineSubtitle

A MacHelper source extension and Chrome companion that display bilingual captions on YouTube watch pages. OnlineSubtitle joins related caption fragments and asks the configured AI to correct obvious transcription errors and translate the result in one request. The source and Simplified Chinese appear together in one caption panel. OnlineSubtitle tries manually authored English first, then uses captions or the transcript available to the current viewer. Other source languages can also be translated. There is no settings screen in this version.

## Set up locally

You need macOS 14 or later, the installed [MacHelper](https://github.com/bosstwobread/LocalAIBaseTools) 6.8.0 or later, Chrome 116 or later, and Xcode Command Line Tools.

1. In MacHelper, open **Extensions → Install Source…**, choose the [MacHelperExtension](MacHelperExtension/) folder, and enable **OnlineSubtitle** after reviewing native code execution and the local Chrome companion’s automatic AI requests.
2. Choose your provider and model in MacHelper’s **AI Connection**. OnlineSubtitle follows those settings for each translation request. Captions go to the selected provider, including its online service if you select ChatGPT.
3. From the project directory run `./scripts/register-chrome-host.sh`. It builds and registers the caption-only native messaging helper for your user.
4. Open `chrome://extensions`, enable **Developer mode**, and use **Load unpacked** to choose the [Chrome](Chrome/) folder. Reload an open YouTube watch page. If you use Language Reactor at the same time, switch it off for that video to avoid overlapping captions.

The unpacked Chrome companion requires one-time user installation. MacHelper must be running with OnlineSubtitle enabled for the bilingual overlay. Disabling it in MacHelper, pausing MacHelper, or losing the connection returns the page to YouTube’s normal captions immediately, using the player’s existing CC setting. Re-enabling restores the overlay on the open watch page.

The Chrome companion 0.3.1 pairs with OnlineSubtitle's 0.3.0 MacHelper source package and native bridge on MacHelper 6.8.0. If you already use the 0.3.0 companion, reload it in Chrome and refresh the watch tab to apply the caption changes. When updating from 0.2.x, disable OnlineSubtitle if it is enabled, then use **Edit Source** to update the installed source package. Preserve any edits to the prompt files. Re-enable OnlineSubtitle and review the new companion permission, then run the registration script again, reload the Chrome companion and refresh the watch tab.

## How it works

```mermaid
flowchart LR
    YT["YouTube timed captions"]
    EX["Chrome caption reader"]
    UI["Chrome player overlay"]
    SW["Chrome service worker"]
    BR["Swift native messaging bridge"]
    MH["MacHelper companion service"]
    WK["Installed OnlineSubtitle worker"]
    AI["Configured AI connection"]

    YT --> EX --> UI
    UI <-->|"Caption batches and enabled status"| SW
    SW <-->|"Chrome Native Messaging"| BR
    BR <-->|"Per-user Unix socket"| MH
    MH <-->|"Approved command"| WK
    WK <-->|"MacHelper’s shared AI"| AI
```

1. **Read the source captions.** The Manifest V3 companion injects a [reader](Chrome/captions.js) into the YouTube page’s JavaScript world and a [controller](Chrome/content.js) into Chrome’s isolated world. The reader checks the active video ID, ranks the available tracks, and tries the existing timed-text track. It can also read YouTube’s transcript panel data when the timed-text response is empty. Both routes produce cues with start and end times and source text. One DOM event delivers the result for the current video to the controller. Caption acquisition uses the viewer’s YouTube session in Chrome and depends on YouTube’s internal response formats.
2. **Synchronize and schedule.** The controller removes [recognized sound labels](Chrome/sound-labels.js) such as `[music]` from dialogue. It [splits source cues at sentence endings](Chrome/sentences.js) and joins short, adjacent fragments of the same sentence. It estimates timing for sentence boundaries inside each cue’s visible interval. The [overlay](Chrome/subtitles.css) follows the video’s playback time above the player controls. The source and Chinese translation share one translucent panel, with type that scales to the player and wraps as needed. The controller starts prefetching translations as soon as OnlineSubtitle is enabled and the foreground watch page has the video’s captions, including during preroll. The first batch has up to three cues and later batches have up to eight. Seeking prioritizes the current line and the next 24 seconds and can cancel a batch far from the new position. Completed translations stay in memory for the current video, and background tabs suspend new requests. Throughout ads, the overlay stays hidden and YouTube uses its existing CC setting. Disabling OnlineSubtitle cancels pending work and restores the normal caption display.
3. **Send a narrow request to the Mac.** The [service worker](Chrome/background.js) accepts the request from the companion’s top frame on a valid YouTube watch URL. A request contains numeric cue IDs and caption text. Chrome launches the [Swift bridge](NativeHost/main.swift) through Native Messaging. The bridge accepts the exact installed companion origin, checks the request and reply, and forwards a single batch to the approved `translate-captions` command over MacHelper’s per-user Unix socket. OnlineSubtitle’s caption payload is bounded to 32 KiB. A separate Native Messaging connection carries enabled-state updates for the open watch page. The bridge closes its MacHelper connection if the browser disconnects.
4. **Translate and validate in the OnlineSubtitle worker.** [The worker](MacHelperExtension/Main.swift) checks cue IDs and text limits, reads its [editable sentence prompt](MacHelperExtension/prompts/translate-sentences.txt), and requests one transformation using MacHelper’s saved **AI Connection**. It validates the reply and returns the Chinese text and optional corrected source for each cue ID. The caption formats, prompts and display rules live in this project. MacHelper supplies the approved command transport, worker lifecycle and shared AI.

OnlineSubtitle keeps its caption and translation cache in memory and renders the finished text in the YouTube player’s shared DOM. Once a translatable cue is available, its caption waits for both lines. If the translation is unavailable, YouTube resumes displaying captions according to the existing CC setting. Browser authentication stays in Chrome. The packaged native worker runs with the macOS user’s permissions after native execution approval. Videos without an accessible caption track or transcript are outside the current scope, as are live transcription and speech recognition.

## Develop and verify

- Run `node --test tests/*.test.cjs` on macOS with Node.js 20.3 or later and Xcode Command Line Tools. Synthetic fixtures cover caption parsing, playback scheduling, the Chrome bridge, and the Swift worker’s caption and status commands.
- Run `./scripts/build-worker.sh /tmp/OnlineSubtitleWorker` to compile the worker outside the editable source folder. The script uses the public SDK shipped in the installed app. For a nonstandard installation or a standalone SDK download, set `MACHELPER_NATIVE_SDK` to the SDK file path. This repository and the shipped SDK are sufficient to build and test the worker.
- After changing browser files, reload the unpacked Chrome companion and the test watch page. Use **Edit Source** in MacHelper when editing the installed extension or its prompt.
