# OnlineSubtitle for MacHelper

Install this folder with **MacHelper → Extensions → Install Source**. Use MacHelper 6.8.0 or later. Review the native execution and local Chrome companion permissions before enabling it.

The worker owns the caption request format, calls MacHelper’s saved **AI Connection**, and validates every translation. The editable prompts are `prompts/translate-sentences.txt` for correction and translation and `prompts/translate-captions.txt` for translation alone. MacHelper compiles the package using its shipped Swift SDK.

The browser companion and native bridge are part of the [OnlineSubtitle project](https://github.com/bosstwobread/OnlineSubtitle-MacHelper).
