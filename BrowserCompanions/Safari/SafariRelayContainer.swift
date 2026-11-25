import AppKit

@main
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let extensionIdentifier = "com.nelson007.online-subtitle.safari"

    func applicationDidFinishLaunching(_ notification: Notification) {
        let identifier = extensionIdentifier
        DispatchQueue.global(qos: .utility).async {
            do {
                let directory = try SafariCompanionRelayGroup.directory()
                try SafariCompanionRelayServer(groupDirectory: directory, extensionBundleIdentifier: identifier).serve()
            } catch {
                // Safari returns an unavailable status if the relay is absent.
                // Native request data must never be included in application logs.
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}
