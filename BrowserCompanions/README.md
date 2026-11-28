# OnlineSubtitle browser companions

OnlineSubtitle shares its YouTube caption reader across Chrome, Edge, Firefox, and Safari. The Chrome and Edge package can also translate upcoming captions from the subtitle track selected in Netflix’s player. When only the displayed subtitle is available, the companion translates the current line. MacHelper detects a supported browser and owns setup of the managed connection. Each browser controls its own installation and site access. OnlineSubtitle sends the active video’s captions and clicked source word to MacHelper for translation or explanation through the configured AI connection. There is no telemetry.

## Build for development or publication

The OnlineSubtitle extension in MacHelper uses its bundled JavaScript worker starting in 0.6.0. The tools below are for developing or publishing browser packages. End users install the browser package through the browser’s own setup flow.

From the repository root, run the following command with Python 3.10 or newer. Choose a new or empty output directory outside the source tree.

```sh
python3 scripts/build-browser-companions.py --output /tmp/OnlineSubtitle-companions
```

The command writes one unpacked folder per browser and the deterministic MacHelper staging inventories `chromium-companion.json` and `firefox-companion.json`. Chrome and Edge share the same Chromium development inventory. The package versions come from the MacHelper source extension manifest. Store publishers use these browser folders as source for each browser's packaging and signing workflow. After store publication, use the actual store-assigned Chromium IDs and official listing URLs in OnlineSubtitle’s MacHelper manifest. The generated developer folders use these identities:

| Browser | Developer identity | Browser enablement |
| --- | --- | --- |
| Chrome 116+ | `ndmbmmhddeibbojclldpaabmkcielfmj` | Load the prepared folder as an unpacked extension for testing. A public install uses the Chrome Web Store. |
| Edge 116+ | `ndmbmmhddeibbojclldpaabmkcielfmj` | Load the prepared folder as an unpacked extension for testing. A public install can use Microsoft Edge Add-ons. |
| Firefox 140+ | `online-subtitle@nelson007.com` | Load the prepared `manifest.json` as a temporary add-on for testing. Persistent distribution requires a Mozilla-signed package. |
| Safari 18+ | `com.nelson007.online-subtitle.safari` | Build the containing macOS app, then enable its web extension in Safari. Distribution requires Apple signing. |

Use MacHelper’s OnlineSubtitle setup controls to prepare the browser’s native connection. The generated browser folders use MacHelper’s scoped `com.localaibasetools.companion` bridge. The repository’s original `Chrome/` folder remains the legacy unpacked build for MacHelper 6.8, in conjunction with `scripts/register-chrome-host.sh`.

## Safari

Use the OnlineSubtitle extension release commit from its Marketplace listing to generate a matching Safari version. On a Mac with Xcode, generate the project in a new or empty directory. Use the App Group registered for your signing team. The generator uses Apple’s Safari packager and embeds the shared web resources, sandboxed native-message handler, and containing app’s relay.

```sh
python3 scripts/build-safari-companion.py \
  --app-group group.com.nelson007.online-subtitle \
  --output /tmp/OnlineSubtitle-Safari
```

Open `OnlineSubtitle/OnlineSubtitle.xcodeproj` inside that directory. Sign the containing app and extension with the same Apple signing team and App Group. Run the app, then enable OnlineSubtitle in **Safari → Settings → Extensions** and grant it access to YouTube. Closing the containing app’s window leaves its local relay running. MacHelper owns the OnlineSubtitle companion permission review.

Safari’s native extension stays sandboxed. It passes bounded status and command requests through the shared App Group to its containing app, which uses MacHelper’s normal per-user Unix socket. The host still checks the exact approved Safari identity and commands. The extension refreshes status while the YouTube watch page keeps its connection open. The relay does not log requests or responses.

The Safari source is provided here for independent builds. This containing app uses Developer ID signing and notarization for public distribution. Verify an actual signed App Group build in Safari before offering consumer installation. A temporarily loaded Safari folder can exercise the web layer. Native messaging requires the containing app.

- [Apple's Safari app packaging and distribution](https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension)
- [Apple's Safari native messaging](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension)
- [Google's extension distribution](https://developer.chrome.com/docs/extensions/how-to/distribute)
- [Microsoft Edge extension distribution](https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/publish-extension)
- [Mozilla signing and distribution](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)

`Safari/CompanionBrokerClient.swift` is the MIT-licensed MacHelper companion socket client, vendored so the Safari package can be generated from this repository alone. Keep it in sync with MacHelper’s protocol and retain the [license](../LICENSE).
