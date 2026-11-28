# OnlineSubtitle

A MacHelper source extension and browser companions that display bilingual captions on YouTube and Netflix. Chrome and Edge support both sites. Firefox and Safari support YouTube. The source and translation appear together in one movable caption panel. Click a word in the source line to see what it means in that sentence. On YouTube, OnlineSubtitle prefers captions that match the video’s audio language. It joins related fragments and asks the configured AI to correct obvious transcription errors and translate the result. The translation target is a separate setting.

## Set up in MacHelper

OnlineSubtitle 0.7.1 requires macOS 14 or later and [MacHelper](https://github.com/bosstwobread/LocalAIBaseTools) 6.9.0 or later. The installed MacHelper app includes the JavaScript worker needed to run the extension.

1. Open **MacHelper → Extensions → Install Source…** and choose [MacHelperExtension](MacHelperExtension/). Review the listed browser companion identities and shared AI access before enabling the tool.
2. Choose your provider and model under **AI Connection**. Captions go to that provider, including its online service if you select ChatGPT.
3. Open **OnlineSubtitle → Browser Companions** and select **Set Up…** next to an installed browser. MacHelper registers its dedicated bridge and prepares the reviewed development files for Chrome, Edge, or Firefox. Follow the browser’s approval and reload the watch page.
4. Safari setup requires a signed containing app. Developers can generate its Xcode project using the [Safari build guide](BrowserCompanions/README.md#safari). MacHelper offers setup after the browser is first opened, even when it was installed after OnlineSubtitle.

The browser source and package tooling are in this repository. Regular distribution requires valid browser-store listings or signed releases. [OnlineSubtitle 0.4.2](https://github.com/bosstwobread/OnlineSubtitle-MacHelper/tree/v0.4.2) is the previous Chrome-only edition for MacHelper 6.8.

## Settings and playback

- Under **MacHelper → Extensions → OnlineSubtitle**, choose **Translate to** and edit the three prompts for captions, caption correction and translation, and word lookup. The default target is Simplified Chinese. The picker also offers Traditional Chinese, English, Japanese, Korean, French, German, Spanish, Portuguese, and Italian. Source captions can be in other languages, such as Arabic. Return to the watch tab for the new preference to take effect. The tool uses the provider and model saved in **AI Connection** for captions and lookups.
- Drag the caption background up or down. You can also focus the caption panel and press the Up or Down arrow. The position carries over to videos opened within the same watch page.
- Click a word in the source line to pause playback and look up the word in that exact sentence. The player panel shows the word's contextual meaning in your target language. Close it with Escape or the close button.

The browser asks for installation and site access approval. MacHelper must be running with OnlineSubtitle enabled for the bilingual overlay. Disabling it in MacHelper, pausing MacHelper, or losing the connection restores the player’s normal captions. Re-enabling restores the overlay on the open watch page.

If YouTube’s caption track is late or a read fails, OnlineSubtitle makes up to three delayed reads in the visible tab. YouTube captions remain available during recovery. Use **Retry** in the subtitle error message to try again on the same page, including after an AI translation fails.

Use **Check for Updates** for a marketplace installation. MacHelper reviews a changed browser declaration and preserves your settings. Use **Set Up…** again when loading a new developer package. In Chrome or Edge, use **Load unpacked** and select the newly prepared folder. If the browser reports that the old unpacked edition has the same ID, remove its old card first. Refresh the watch tab after the new edition is enabled.

## Netflix in Chrome and Edge

Open a title and choose the source language under Netflix’s **Audio & Subtitles**. When the player provides timed subtitles that match the selected track, OnlineSubtitle translates upcoming lines in batches so they can appear as the dialogue starts. If the player exposes only the current line, OnlineSubtitle translates it as it appears. Netflix’s original caption stays visible while a translation is pending. Click a word in the bilingual panel to look it up in context.

## How it works on YouTube

```mermaid
flowchart LR
    YT["YouTube timed captions"]
    EX["Browser caption reader"]
    UI["Browser player overlay"]
    SW["Extension background"]
    BR["Swift native messaging bridge"]
    MH["MacHelper companion service"]
    WK["MacHelper JavaScript worker"]
    AI["Configured AI connection"]

    YT --> EX --> UI
    UI <-->|"Caption batches and enabled status"| SW
    SW <-->|"Native Messaging"| BR
    BR <-->|"Per-user Unix socket"| MH
    MH <-->|"Approved command"| WK
    WK <-->|"MacHelper’s shared AI"| AI
```

1. **Read the source captions.** The Manifest V3 companion injects a [reader](Chrome/captions.js) into the YouTube page’s JavaScript world and a [controller](Chrome/content.js) into the browser’s isolated world. The reader checks the active video ID, ranks the available tracks, and tries the existing timed-text track. It can also read YouTube’s transcript panel data when the timed-text response is empty. Both routes produce cues with start and end times and source text. One DOM event delivers the result for the current video to the controller. Caption acquisition uses the viewer’s YouTube session and depends on YouTube’s internal response formats.
2. **Synchronize and schedule.** The controller removes [recognized sound labels](Chrome/sound-labels.js) such as `[music]` from dialogue. It [splits source cues at sentence endings](Chrome/sentences.js) and joins short, adjacent fragments of the same sentence. It estimates timing for sentence boundaries inside each cue’s visible interval. The [overlay](Chrome/subtitles.css) follows the video’s playback time above the player controls. The source and its translation share one translucent panel, with type that scales to the player and wraps as needed. The controller starts prefetching translations as soon as OnlineSubtitle is enabled and the foreground watch page has the video’s captions, including during preroll. The first batch has up to three cues and later batches have up to eight. Seeking prioritizes the current line and the next 24 seconds and can cancel a batch far from the new position. Completed translations stay in memory for the current video, and background tabs suspend new requests. Throughout ads, the overlay stays hidden and YouTube uses its existing CC setting. Disabling OnlineSubtitle cancels pending work and restores the normal caption display.
3. **Send a narrow request to the Mac.** The [browser background](Chrome/background.js) accepts the request from the companion’s top frame on a valid YouTube watch URL. MacHelper’s managed Native Messaging host checks the exact approved browser and companion identity before forwarding a bounded batch to the worker. Safari uses its own containing app to reach the same approved command service. The companion monitors enabled state while the watch page is open.
4. **Translate and validate in the OnlineSubtitle worker.** [The script](MacHelperExtension/main.js) checks cue IDs and text limits, reads its [editable sentence prompt](MacHelperExtension/prompts/translate-sentences.txt), and requests one transformation using MacHelper’s saved **AI Connection**. It validates the reply and returns the text in the chosen language and optional corrected source for each cue ID. The caption formats, prompts and display rules live in this project. MacHelper supplies the approved command transport, worker lifecycle and shared AI.
5. **Explain a source word on click.** The browser sends the selected word and its complete source line as context through a dedicated companion command. The worker uses the [editable lookup prompt](MacHelperExtension/prompts/word-in-context.txt) to return the contextual definition. A separate preferences command returns the target and a revision for cache invalidation. The browser receives no prompt text through that command.

OnlineSubtitle keeps its caption and translation cache in memory and renders the finished text in the YouTube player’s shared DOM. Once a translatable cue is available, its caption waits for both lines. While another tab or browser is using the same MacHelper extension worker, the waiting tab can show its YouTube captions and retries when the worker is available. If a translation fails, YouTube resumes displaying captions according to the existing CC setting. Browser authentication stays in the browser. Videos without an accessible caption track or transcript are outside the current scope, as are live transcription and speech recognition.

## Develop and verify

- Run `node --test tests/worker.test.cjs` with Node.js 20.3 or later to test the caption commands with a fixture AI response. Set `MACHELPER_SCRIPT_WORKER` to the installed app’s `Contents/MacOS/MacHelperScriptWorker` to exercise the same cases in MacHelper’s JavaScriptCore worker.
- Run `node --test tests/*.test.cjs` for the browser and caption regression suite. The browser package fixtures use Python 3.10 or later. The Safari relay and legacy Chrome bridge tests compile macOS fixtures using Xcode Command Line Tools.
- After changing browser files, reload the developer companion and the test watch page. Use **Edit Source** in MacHelper when editing the installed extension or its prompt.
