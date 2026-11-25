import Foundation

private let maximumCaptionFrameBytes = 32 * 1024
private let captionPromptPath = "prompts/translate-captions.txt"
private let sentencePromptPath = "prompts/translate-sentences.txt"

private enum CaptionFailure: String, Error, Encodable {
    case invalid, unavailable, translation
}

private struct CaptionCue: Codable {
    let id: Int
    let text: String

    func isValid(maximumBytes: Int) -> Bool {
        (1...9_007_199_254_740_991).contains(id) && text.utf8.count <= maximumBytes &&
            !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !text.unicodeScalars.contains { scalar in
                scalar.value == 127 || (scalar.value < 32 && ![9, 10, 13].contains(scalar.value))
            }
    }
}

private struct CaptionRequest: Decodable {
    enum Kind: String, Decodable { case translate, translateSentences }

    let type: Kind
    let cues: [CaptionCue]

    static func decode(_ text: String) throws -> Self {
        guard text.utf8.count <= maximumCaptionFrameBytes else { throw CaptionFailure.invalid }
        let data = Data(text.utf8)
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["type", "cues"], let fields = object["cues"] as? [[String: Any]],
              (1...8).contains(fields.count), fields.allSatisfy({ Set($0.keys) == ["id", "text"] }),
              let request = try? JSONDecoder().decode(Self.self, from: data),
              request.cues.allSatisfy({ $0.isValid(maximumBytes: 1_000) }),
              Set(request.cues.map(\.id)).count == request.cues.count else { throw CaptionFailure.invalid }
        return request
    }
}

private struct CaptionTranslation: Codable {
    let id: Int
    let text: String
    let source: String?

    func isValid() -> Bool {
        CaptionCue(id: id, text: text).isValid(maximumBytes: 2_000) &&
            (source.map { CaptionCue(id: id, text: $0).isValid(maximumBytes: 1_000) } ?? true)
    }
}

private struct CaptionModelResult: Decodable {
    let translations: [CaptionTranslation]

    static func decode(_ answer: String, matching cues: [CaptionCue], allowsSource: Bool) throws -> [CaptionTranslation] {
        guard answer.utf8.count <= maximumCaptionFrameBytes else { throw CaptionFailure.translation }
        var text = answer.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\r\n", with: "\n")
        // Some providers wrap the complete JSON answer in a code fence.
        if let newline = text.firstIndex(of: "\n"),
           ["```json", "```"].contains(String(text[..<newline])), text.hasSuffix("\n```") {
            let closing = text.index(text.endIndex, offsetBy: -4)
            guard newline < closing else { throw CaptionFailure.translation }
            text = String(text[text.index(after: newline)..<closing])
        }
        let data = Data(text.utf8)
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["translations"], let fields = object["translations"] as? [[String: Any]],
              fields.count == cues.count, fields.allSatisfy({ row in
                  let keys = Set(row.keys)
                  return keys == ["id", "text"] ||
                      (allowsSource && keys == ["id", "text", "source"] && row["source"] is String)
              }),
              let result = try? JSONDecoder().decode(Self.self, from: data),
              result.translations.map(\.id) == cues.map(\.id),
              result.translations.allSatisfy({ $0.isValid() }) else { throw CaptionFailure.translation }
        return zip(result.translations, cues).map { translation, cue in
            CaptionTranslation(id: translation.id, text: translation.text,
                source: translation.source == cue.text ? nil : translation.source)
        }
    }
}

private struct CaptionReply: Encodable {
    let ok: Bool
    var translations: [CaptionTranslation]? = nil
    var error: CaptionFailure? = nil

    func commandResult() throws -> [String: Any] {
        let payload = try JSONEncoder().encode(self)
        guard payload.count <= maximumCaptionFrameBytes else { throw CaptionFailure.translation }
        return ["text": String(decoding: payload, as: UTF8.self)]
    }
}

@main
private enum OnlineSubtitle {
    @MainActor
    static func main() {
        MacHelperNative.run(commands: [
            "status": { _ in ["title": "OnlineSubtitle", "text": "OnlineSubtitle is ready for the Chrome companion."] },
            "translate-captions": translate
        ])
    }

    @MainActor
    private static func translate(_ input: MacHelperNativeInput) async throws -> [String: Any] {
        do {
            let request = try CaptionRequest.decode(input.text)
            let sentencePrompt = request.type == .translateSentences ? prompt(sentencePromptPath, input) : nil
            guard let systemPrompt = sentencePrompt ?? prompt(captionPromptPath, input) else {
                throw CaptionFailure.unavailable
            }
            let cues = try JSONEncoder().encode(request.cues)
            let result = try await input.transform(request: [
                "action": "translate", "targetLanguage": "zh-CN", "systemPrompt": systemPrompt,
                "text": String(decoding: cues, as: UTF8.self)
            ])
            try Task.checkCancellation()
            guard let answer = result["text"] as? String else { throw CaptionFailure.translation }
            let translations = try CaptionModelResult.decode(answer, matching: request.cues, allowsSource: sentencePrompt != nil)
            return try CaptionReply(ok: true, translations: translations).commandResult()
        } catch {
            try Task.checkCancellation()
            return try CaptionReply(ok: false, error: (error as? CaptionFailure) ?? .translation).commandResult()
        }
    }

    @MainActor
    private static func prompt(_ path: String, _ input: MacHelperNativeInput) -> String? {
        guard let value = try? input.readText(path), value.utf8.count <= 12_000, !value.contains("\0"),
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return value
    }
}
