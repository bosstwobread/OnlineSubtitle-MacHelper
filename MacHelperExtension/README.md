# OnlineSubtitle for MacHelper

Enable OnlineSubtitle to start the local subtitle translation worker. It accepts short caption batches from the OnlineSubtitle Chrome companion and translates them into Simplified Chinese with Ollama on this Mac. It requires the companion and its caption-only native messaging bridge, with an existing YouTube caption track and a local chat model in Ollama.

This extension requires trusted native execution and uses a private Unix socket. It does not use selected text or Accessibility. It has no extension settings. The Chrome and native bridge sources and setup instructions are in the [OnlineSubtitle-MacHelper project](https://github.com/bosstwobread/OnlineSubtitle-MacHelper).
