# OnlineSubtitle for MacHelper

Install this folder with **MacHelper → Extensions → Install Source…** using MacHelper 6.9.0 or later. Review native execution and the listed companion identities before enabling. Then use **Browser Companions → Set Up…** to prepare the companion and complete the browser’s installation approval.

Open **Extensions → OnlineSubtitle → Settings** to choose a target language and edit the three prompts. MacHelper saves each prompt to the corresponding file under `prompts/`. The default translation language is Simplified Chinese. Prompts receive the selected target language through the model’s JSON input. When bringing over a customized prompt from 0.3.0, adapt it to the new input object with `targetLanguage` and `cues` so it follows the language menu.

MacHelper compiles the package using its shipped Swift SDK. OnlineSubtitle owns its captions, word lookup, prompts, and result validation. The approved companion commands read the effective caption preferences, translate a batch with optional corrections, or explain a word clicked in the original captions. The companion works with the original caption language available on YouTube. Lookup uses the full source sentence as context and returns the word’s meaning in the selected language. The settings reply contains the target language and a revision identifier. Translation and lookup use MacHelper’s saved **AI Connection**.

See the [browser companion documentation](https://github.com/bosstwobread/OnlineSubtitle-MacHelper/blob/134f7b5be1a2d3c87e65c4a90f47336a553b19f0/BrowserCompanions/README.md) for developer packages, Safari signing, and legacy Chrome setup.
