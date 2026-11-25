import SafariServices

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let input = context.inputItems.first as? NSExtensionItem
        guard context.inputItems.count == 1,
              let request = input?.userInfo?[SFExtensionMessageKey] as? [String: Any] else {
            Self.finish(context, with: CompanionBridgeFailure.invalid.response)
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let reply: [String: Any]
            do {
                let group = try SafariCompanionRelayGroup.directory(bundle: Bundle(for: SafariWebExtensionHandler.self))
                let timeout = request["type"] as? String == "getStatus" ? 4 : 65
                let deadline = DispatchTime.now() + .seconds(timeout)
                reply = try SafariCompanionRelayClient(groupDirectory: group).request(request, before: deadline)
            } catch let error as CompanionBridgeFailure {
                reply = error.response
            } catch {
                reply = CompanionBridgeFailure.unavailable.response
            }
            Self.finish(context, with: reply)
        }
    }

    private static func finish(_ context: NSExtensionContext, with reply: [String: Any]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: reply]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
