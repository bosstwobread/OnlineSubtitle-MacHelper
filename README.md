# OnlineSubtitle

A MacHelper source extension and Chrome companion that display bilingual captions on YouTube watch pages. OnlineSubtitle joins related caption fragments and asks the configured AI to correct obvious transcription errors and translate the result in one request. The source and translation appear together in one movable caption panel. Click a word in the source line to see what it means in that sentence. OnlineSubtitle prefers captions that match the video’s audio language, using the available YouTube captions or transcript. The translation target is a separate setting.

## Install from the marketplace

You need macOS 14 or later, the installed [MacHelper](https://github.com/bosstwobread/LocalAIBaseTools) 6.8.0 or later, Chrome 116 or later, and Xcode Command Line Tools.

1. Open the [OnlineSubtitle marketplace page](https://local-ai-extension.nelson007.com/#extension/online-subtitle) and choose **Add to MacHelper**. Review its native execution and browser companion permissions before enabling it. For a local checkout, you can instead open **MacHelper → Extensions → Install Source…** and choose the [MacHelperExtension](MacHelperExtension/) folder.
2. Choose your provider and model in MacHelper’s **AI Connection**. Captions go to that provider, including its online service if you select ChatGPT.
3. [Download the OnlineSubtitle 0.4.2 project](https://github.com/bosstwobread/OnlineSubtitle-MacHelper/archive/refs/tags/v0.4.2.zip) and extract it to a folder you’ll keep. From that folder, run `./scripts/register-chrome-host.sh` in Terminal. It builds and registers the caption-only native messaging helper for your user.
4. Open `chrome://extensions`, enable **Developer mode**, and use **Load unpacked** to choose the extracted [Chrome](Chrome/) folder. Reload an open YouTube watch page. If you use Language Reactor at the same time, switch it off for that video to avoid overlapping captions.

## Settings and playback

- Under **MacHelper → Extensions → OnlineSubtitle**, choose **Translate to** and edit the three prompts for captions, caption correction and translation, and word lookup. The default target is Simplified Chinese. The picker also offers Traditional Chinese, English, Japanese, Korean, French, German, Spanish, Portuguese, and Italian. Source captions can be in other languages, such as Arabic. Return to the YouTube tab for the new preference to take effect. The tool uses the provider and model saved in **AI Connection** for captions and lookups.
- Drag the caption background up or down. You can also focus the caption panel and press the Up or Down arrow. The position carries over to videos opened within the same watch page.
- Click a word in the source line to pause playback and look up the word in that exact sentence. The player panel shows the word's contextual meaning in your target language. Close it with Escape or the close button.

The unpacked Chrome companion requires one-time user installation. MacHelper must be running with OnlineSubtitle enabled for the bilingual overlay. Disabling it in MacHelper, pausing MacHelper, or losing the connection returns the page to YouTube’s normal captions immediately, using the player’s existing CC setting. Re-enabling restores the overlay on the open watch page.

OnlineSubtitle 0.4.2 uses the matching MacHelper source package, Chrome companion, and native bridge. To update a marketplace install, use **Check for Updates** in MacHelper. For a manual install, update the installed files under **Edit Source**, keeping any custom prompt edits. Update the files in the folder loaded by Chrome, run the registration script again, reload the companion, and refresh the watch tab.

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
2. **Synchronize and schedule.** The controller removes [recognized sound labels](Chrome/sound-labels.js) such as `[music]` from dialogue. It [splits source cues at sentence endings](Chrome/sentences.js) and joins short, adjacent fragments of the same sentence. It estimates timing for sentence boundaries inside each cue’s visible interval. The [overlay](Chrome/subtitles.css) follows the video’s playback time above the player controls. The source and its translation share one translucent panel, with type that scales to the player and wraps as needed. The controller starts prefetching translations as soon as OnlineSubtitle is enabled and the foreground watch page has the video’s captions, including during preroll. The first batch has up to three cues and later batches have up to eight. Seeking prioritizes the current line and the next 24 seconds and can cancel a batch far from the new position. Completed translations stay in memory for the current video, and background tabs suspend new requests. Throughout ads, the overlay stays hidden and YouTube uses its existing CC setting. Disabling OnlineSubtitle cancels pending work and restores the normal caption display.
3. **Send a narrow request to the Mac.** The [service worker](Chrome/background.js) accepts the request from the companion’s top frame on a valid YouTube watch URL. A request contains numeric cue IDs and caption text. Chrome launches the [Swift bridge](NativeHost/main.swift) through Native Messaging. The bridge accepts the exact installed companion origin, checks the request and reply, and forwards a single batch to the approved `translate-captions` command over MacHelper’s per-user Unix socket. OnlineSubtitle’s caption payload is bounded to 32 KiB. A separate Native Messaging connection carries enabled-state updates for the open watch page. The bridge closes its MacHelper connection if the browser disconnects.
4. **Translate and validate in the OnlineSubtitle worker.** [The worker](MacHelperExtension/Main.swift) checks cue IDs and text limits, reads its [editable sentence prompt](MacHelperExtension/prompts/translate-sentences.txt), and requests one transformation using MacHelper’s saved **AI Connection**. It validates the reply and returns the text in the chosen language and optional corrected source for each cue ID. The caption formats, prompts and display rules live in this project. MacHelper supplies the approved command transport, worker lifecycle and shared AI.
5. **Explain a source word on click.** The browser sends the selected word and its complete source line as context through a dedicated companion command. The worker uses the [editable lookup prompt](MacHelperExtension/prompts/word-in-context.txt) to return the contextual definition. A separate preferences command returns the target and a revision for cache invalidation. The browser receives no prompt text through that command.

OnlineSubtitle keeps its caption and translation cache in memory and renders the finished text in the YouTube player’s shared DOM. Once a translatable cue is available, its caption waits for both lines. If the translation is unavailable, YouTube resumes displaying captions according to the existing CC setting. Browser authentication stays in Chrome. The packaged native worker runs with the macOS user’s permissions after native execution approval. Videos without an accessible caption track or transcript are outside the current scope, as are live transcription and speech recognition.

## Develop and verify

- Run `node --test tests/*.test.cjs` on macOS with Node.js 20.3 or later and Xcode Command Line Tools. Synthetic fixtures cover multilingual caption extraction and grouping, playback scheduling, the Chrome bridge, and the Swift worker’s caption and lookup commands.
- Run `./scripts/build-worker.sh /tmp/OnlineSubtitleWorker` to compile the worker outside the editable source folder. The script uses the public SDK shipped in the installed app. For a nonstandard installation or a standalone SDK download, set `MACHELPER_NATIVE_SDK` to the SDK file path. This repository and the shipped SDK are sufficient to build and test the worker.
- After changing browser files, reload the unpacked Chrome companion and the test watch page. Use **Edit Source** in MacHelper when editing the installed extension or its prompt.
