# OnlineSubtitle for MacHelper

Install this folder with **MacHelper → Extensions → Install Source**. Use MacHelper 6.8.0 or later and pair this source package with the OnlineSubtitle 0.4.0 Chrome companion and native bridge. Review the native execution and local Chrome companion permissions before enabling it. When upgrading an existing installation, disable and re-enable the source extension to review the expanded companion command list.

Open **Extensions → OnlineSubtitle → Settings** to choose a target language and edit the three prompts. MacHelper saves each prompt to the corresponding file under `prompts/`. The default translation language is Simplified Chinese. Prompts receive the selected target language through the model’s JSON input. When bringing over a customized prompt from 0.3.0, adapt it to the new input object with `targetLanguage` and `cues` so it follows the language menu.

MacHelper compiles the package using its shipped Swift SDK. OnlineSubtitle owns its captions, word lookup, prompts, and result validation. The approved companion commands read the effective caption preferences, translate a batch with optional corrections, or explain a clicked word in context and translate the whole sentence. The settings reply contains the target language and a revision identifier. Translation and lookup use MacHelper’s saved **AI Connection**.

The browser companion and native bridge are part of the [OnlineSubtitle project](https://github.com/bosstwobread/OnlineSubtitle-MacHelper).
