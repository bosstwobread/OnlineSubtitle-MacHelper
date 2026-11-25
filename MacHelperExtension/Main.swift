import CryptoKit
import Foundation

private let maximumCaptionFrameBytes = 32 * 1024
private let captionPromptPath = "prompts/translate-captions.txt"
private let sentencePromptPath = "prompts/translate-sentences.txt"
private let wordPromptPath = "prompts/word-in-context.txt"
private let supportedLanguages: Set<String> = ["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "pt", "it"]

private enum CaptionFailure: String, Error, Encodable {
    case invalid, unavailable, translation
}

private func validText(_ text: String, maximumBytes: Int) -> Bool {
    text.utf8.count <= maximumBytes && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !text.unicodeScalars.contains { scalar in
            scalar.value == 127 || (scalar.value < 32 && ![9, 10, 13].contains(scalar.value))
        }
}

private struct CaptionCue: Codable {
    let id: Int
    let text: String

    func isValid(maximumBytes: Int) -> Bool {
        (1...9_007_199_254_740_991).contains(id) && validText(text, maximumBytes: maximumBytes)
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

private struct WordContext {
    let word: String
    let sentence: String

    static func decode(_ text: String) throws -> Self {
        guard text.utf8.count <= maximumCaptionFrameBytes else { throw CaptionFailure.invalid }
        guard let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: String],
              Set(object.keys) == ["type", "word", "sentence"], object["type"] == "explainWord",
              let word = object["word"], validText(word, maximumBytes: 256),
              word == word.trimmingCharacters(in: .whitespacesAndNewlines),
              let sentence = object["sentence"], validText(sentence, maximumBytes: 2_000),
              sentence.range(of: word, options: .literal) != nil else { throw CaptionFailure.invalid }
        return WordContext(word: word, sentence: sentence)
    }
}

private struct CaptionModelInput: Encodable {
    let targetLanguage: String
    let cues: [CaptionCue]
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

private func modelJSON(_ answer: String) throws -> Data {
    guard answer.utf8.count <= maximumCaptionFrameBytes else { throw CaptionFailure.translation }
    var text = answer.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\r\n", with: "\n")
    // Some providers wrap the complete JSON answer in a code fence.
    if let newline = text.firstIndex(of: "\n"),
       ["```json", "```"].contains(String(text[..<newline])), text.hasSuffix("\n```") {
        let closing = text.index(text.endIndex, offsetBy: -4)
        guard newline < closing else { throw CaptionFailure.translation }
        text = String(text[text.index(after: newline)..<closing])
    }
    return Data(text.utf8)
}

private struct CaptionModelResult: Decodable {
    let translations: [CaptionTranslation]

    static func decode(_ answer: String, matching cues: [CaptionCue], allowsSource: Bool) throws -> [CaptionTranslation] {
        let data = try modelJSON(answer)
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

private struct WordMeaning {
    let meaning: String
    let sentenceMeaning: String

    static func decode(_ answer: String) throws -> Self {
        let data = try modelJSON(answer)
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              Set(object.keys) == ["meaning", "sentenceMeaning"],
              let meaning = object["meaning"], validText(meaning, maximumBytes: 2_000),
              let sentenceMeaning = object["sentenceMeaning"],
              validText(sentenceMeaning, maximumBytes: 2_000) else { throw CaptionFailure.translation }
        return WordMeaning(meaning: meaning, sentenceMeaning: sentenceMeaning)
    }
}

private struct CaptionSettings {
    let targetLanguage: String
    let revision: String
    let captionPrompt: String?
    let sentencePrompt: String?
    let wordPrompt: String?

    @MainActor
    init(_ input: MacHelperNativeInput) {
        let language = input.settings["targetLanguage"] as? String ?? "zh-CN"
        targetLanguage = supportedLanguages.contains(language) ? language : "zh-CN"
        captionPrompt = Self.prompt(captionPromptPath, input)
        sentencePrompt = Self.prompt(sentencePromptPath, input)
        wordPrompt = Self.prompt(wordPromptPath, input)
        // Valid prompts cannot contain the delimiter. The digest signals that
        // cache entries need replacing without disclosing editable prompts.
        let values = [targetLanguage, captionPrompt ?? "", sentencePrompt ?? "", wordPrompt ?? ""]
        revision = SHA256.hash(data: Data(values.joined(separator: "\0").utf8))
            .map { String(format: "%02x", $0) }.joined()
    }

    @MainActor
    private static func prompt(_ path: String, _ input: MacHelperNativeInput) -> String? {
        guard let value = try? input.readText(path), value.count <= 12_000, value.utf8.count <= 48_000, !value.contains("\0"),
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return value
    }
}

private struct CaptionReply: Encodable {
    let ok: Bool
    var translations: [CaptionTranslation]? = nil
    var meaning: String? = nil
    var sentenceMeaning: String? = nil
    var targetLanguage: String? = nil
    var revision: String? = nil
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
            "caption-settings": getSettings,
            "translate-captions": translate,
            "explain-word": explainWord
        ])
    }

    @MainActor
    private static func getSettings(_ input: MacHelperNativeInput) throws -> [String: Any] {
        guard input.text.utf8.count <= maximumCaptionFrameBytes,
              let request = try? JSONSerialization.jsonObject(with: Data(input.text.utf8)) as? [String: String],
              request == ["type": "getSettings"] else {
            return try CaptionReply(ok: false, error: .invalid).commandResult()
        }
        let settings = CaptionSettings(input)
        return try CaptionReply(ok: true, targetLanguage: settings.targetLanguage, revision: settings.revision).commandResult()
    }

    @MainActor
    private static func translate(_ input: MacHelperNativeInput) async throws -> [String: Any] {
        do {
            let request = try CaptionRequest.decode(input.text)
            let settings = CaptionSettings(input)
            let sentencePrompt = request.type == .translateSentences ? settings.sentencePrompt : nil
            guard let prompt = sentencePrompt ?? settings.captionPrompt else {
                throw CaptionFailure.unavailable
            }
            let data = CaptionModelInput(targetLanguage: settings.targetLanguage, cues: request.cues)
            let answer = try await transform(input, data: data, settings: settings, prompt: prompt)
            let translations = try CaptionModelResult.decode(answer, matching: request.cues, allowsSource: sentencePrompt != nil)
            return try CaptionReply(ok: true, translations: translations, targetLanguage: settings.targetLanguage,
                                    revision: settings.revision).commandResult()
        } catch {
            try Task.checkCancellation()
            return try CaptionReply(ok: false, error: (error as? CaptionFailure) ?? .translation).commandResult()
        }
    }

    @MainActor
    private static func explainWord(_ input: MacHelperNativeInput) async throws -> [String: Any] {
        do {
            let context = try WordContext.decode(input.text)
            let settings = CaptionSettings(input)
            guard let prompt = settings.wordPrompt else { throw CaptionFailure.unavailable }
            let data = ["targetLanguage": settings.targetLanguage, "word": context.word, "sentence": context.sentence]
            let answer = try await transform(input, data: data, settings: settings, prompt: prompt)
            let result = try WordMeaning.decode(answer)
            return try CaptionReply(ok: true, meaning: result.meaning, sentenceMeaning: result.sentenceMeaning,
                                    targetLanguage: settings.targetLanguage, revision: settings.revision).commandResult()
        } catch {
            try Task.checkCancellation()
            return try CaptionReply(ok: false, error: (error as? CaptionFailure) ?? .translation).commandResult()
        }
    }

    @MainActor
    private static func transform(_ input: MacHelperNativeInput, data: some Encodable,
                                  settings: CaptionSettings, prompt: String) async throws -> String {
        let payload = try JSONEncoder().encode(data)
        let result = try await input.transform(request: [
            "action": "translate", "targetLanguage": settings.targetLanguage, "systemPrompt": prompt,
            "text": String(decoding: payload, as: UTF8.self)
        ])
        try Task.checkCancellation()
        guard let answer = result["text"] as? String else { throw CaptionFailure.translation }
        return answer
    }
}
