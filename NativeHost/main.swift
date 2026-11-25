import Darwin
import Foundation

private let chromeExtensionID = "ndmbmmhddeibbojclldpaabmkcielfmj"
private let allowedOrigin = "chrome-extension://\(chromeExtensionID)/"
private let extensionID = "com.nelson007.online-subtitle"
private let supportedLanguages: Set<String> = ["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "pt", "it"]
private let maximumFrameBytes = 32 * 1024
private let maximumBrokerFrameBytes = 128 * 1024
private let maximumStatusFrameBytes = 1_024
private let statusRequest = ["type": "watchStatus"]
private let standardInput = STDIN_FILENO
private let standardOutput = STDOUT_FILENO

private enum BridgeError: Error {
    case disconnected, invalid, unavailable
}

private enum CommandError: String, Codable {
    case unavailable, busy, model, translation, invalid
}

private func isBoundedText(_ text: String, bytes: Int) -> Bool {
    text.utf8.count <= bytes && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !text.unicodeScalars.contains { scalar in
            scalar.value == 127 || (scalar.value < 32 && ![9, 10, 13].contains(scalar.value))
        }
}

private struct Cue: Codable {
    let id: Int
    let text: String
    private(set) var source: String?

    private enum CodingKeys: String, CodingKey { case id, text, source }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(Int.self, forKey: .id)
        text = try values.decode(String.self, forKey: .text)
        source = try? values.decode(String.self, forKey: .source)
    }

    func isValid(textLimit: Int) -> Bool {
        (1...9_007_199_254_740_991).contains(id) && isBoundedText(text, bytes: textLimit)
    }

    mutating func filterSource(allowed: Bool) {
        if !allowed || source.map({ isBoundedText($0, bytes: 1_000) }) == false { source = nil }
    }
}

private struct CommandRequest: Codable {
    enum Kind: String, Codable {
        case translate, translateSentences, getSettings, explainWord

        var command: String {
            switch self {
            case .translate, .translateSentences: return "translate-captions"
            case .getSettings: return "caption-settings"
            case .explainWord: return "explain-word"
            }
        }
    }

    let type: Kind
    let cues: [Cue]?
    let word: String?
    let sentence: String?

    static func decode(_ data: Data) throws -> Self {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let request = try? JSONDecoder().decode(Self.self, from: data) else { throw BridgeError.invalid }
        let keys = Set(object.keys)
        switch request.type {
        case .translate, .translateSentences:
            guard keys == ["type", "cues"], let rawCues = object["cues"] as? [[String: Any]],
                  rawCues.allSatisfy({ Set($0.keys) == ["id", "text"] }),
                  let cues = request.cues, (1...8).contains(cues.count),
                  cues.allSatisfy({ $0.isValid(textLimit: 1_000) }),
                  Set(cues.map(\.id)).count == cues.count else { throw BridgeError.invalid }
        case .getSettings:
            guard keys == ["type"] else { throw BridgeError.invalid }
        case .explainWord:
            guard keys == ["type", "word", "sentence"],
                  let word = request.word, isBoundedText(word, bytes: 256),
                  let sentence = request.sentence, isBoundedText(sentence, bytes: 2_000),
                  sentence.range(of: word, options: .literal) != nil else { throw BridgeError.invalid }
        }
        return request
    }
}

private struct CommandResponse: Codable {
    let ok: Bool
    private(set) var translations: [Cue]?
    let error: CommandError?
    let targetLanguage: String?
    let revision: String?
    let meaning: String?
    let sentenceMeaning: String?

    init(error: CommandError) {
        ok = false
        translations = nil
        self.error = error
        targetLanguage = nil
        revision = nil
        meaning = nil
        sentenceMeaning = nil
    }

    private var hasSettings: Bool {
        guard let targetLanguage, supportedLanguages.contains(targetLanguage),
              let revision, revision.utf8.count == 64 else { return false }
        return revision.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    static func decode(_ data: Data, for request: CommandRequest) throws -> Self {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              var response = try? JSONDecoder().decode(Self.self, from: data) else { throw BridgeError.unavailable }
        let keys = Set(object.keys)
        guard response.ok else {
            guard keys == ["ok", "error"], response.error != nil else { throw BridgeError.unavailable }
            return response
        }
        let settingsKeys: Set<String> = ["ok", "targetLanguage", "revision"]
        switch request.type {
        case .translate, .translateSentences:
            guard keys == ["ok", "translations"] || (keys == settingsKeys.union(["translations"]) && response.hasSettings),
                  let cues = request.cues, var translations = response.translations,
                  translations.count == cues.count, translations.allSatisfy({ $0.isValid(textLimit: 2_000) }),
                  translations.map(\.id) == cues.map(\.id) else { throw BridgeError.unavailable }
            for index in translations.indices {
                translations[index].filterSource(allowed: request.type == .translateSentences)
            }
            response.translations = translations
        case .getSettings:
            guard keys == settingsKeys, response.hasSettings else { throw BridgeError.unavailable }
        case .explainWord:
            guard keys == settingsKeys.union(["meaning", "sentenceMeaning"]), response.hasSettings,
                  let meaning = response.meaning, isBoundedText(meaning, bytes: 2_000),
                  let sentenceMeaning = response.sentenceMeaning,
                  isBoundedText(sentenceMeaning, bytes: 2_000) else { throw BridgeError.unavailable }
        }
        return response
    }
}

private struct StatusUpdate: Codable {
    let type: String
    let enabled: Bool

    static func decode(_ data: Data) throws -> Self {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["type", "enabled"],
              let status = try? JSONDecoder().decode(Self.self, from: data), status.type == "status" else {
            throw BridgeError.invalid
        }
        return status
    }
}

private struct BrokerResponse: Decodable {
    enum Failure: String, Decodable {
        case invalid, unavailable, busy, failed

        var commandError: CommandError {
            switch self {
            case .invalid: return .invalid
            case .unavailable: return .unavailable
            case .busy: return .busy
            case .failed: return .translation
            }
        }
    }

    let ok: Bool
    let payload: String?
    let error: Failure?

    static func decode(_ data: Data, for request: CommandRequest) throws -> CommandResponse {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let reply = try? JSONDecoder().decode(Self.self, from: data) else { throw BridgeError.unavailable }
        if reply.ok {
            guard Set(object.keys) == ["ok", "payload"], let payload = reply.payload,
                  payload.utf8.count <= maximumFrameBytes else { throw BridgeError.unavailable }
            return try CommandResponse.decode(Data(payload.utf8), for: request)
        }
        guard Set(object.keys) == ["ok", "error"], let error = reply.error else { throw BridgeError.unavailable }
        return CommandResponse(error: error.commandError)
    }
}

private func waitFor(_ descriptor: Int32, events: Int16, until deadline: DispatchTime?,
                     monitorBrowser: Bool) throws {
    var watched = [pollfd(fd: descriptor, events: events, revents: 0)]
    if monitorBrowser { watched.append(pollfd(fd: standardInput, events: Int16(POLLIN), revents: 0)) }
    while true {
        var milliseconds: Int32 = -1
        if let deadline {
            let now = DispatchTime.now().uptimeNanoseconds
            guard now < deadline.uptimeNanoseconds else { throw BridgeError.unavailable }
            let remaining = deadline.uptimeNanoseconds - now
            milliseconds = Int32(clamping: (remaining + 999_999) / 1_000_000)
        }
        let ready = watched.withUnsafeMutableBufferPointer { poll($0.baseAddress, nfds_t($0.count), milliseconds) }
        if ready < 0, errno == EINTR { continue }
        guard ready > 0 else { throw BridgeError.unavailable }
        if monitorBrowser, watched[1].revents != 0 { throw BridgeError.disconnected }
        // HUP may arrive with the final readable data. Let read/write determine
        // whether any of the requested bytes are still available.
        if watched[0].revents & events != 0 { return }
        throw descriptor == standardInput ? BridgeError.disconnected : BridgeError.unavailable
    }
}

private func setNonblocking(_ descriptor: Int32) throws {
    let flags = fcntl(descriptor, F_GETFL)
    guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 else { throw BridgeError.unavailable }
}

private func readBytes(_ count: Int, from descriptor: Int32, until deadline: DispatchTime,
                       monitorBrowser: Bool) throws -> Data {
    var data = Data(count: count)
    try data.withUnsafeMutableBytes { buffer in
        var offset = 0
        while offset < count {
            try waitFor(descriptor, events: Int16(POLLIN), until: deadline, monitorBrowser: monitorBrowser)
            let received = read(descriptor, buffer.baseAddress!.advanced(by: offset), count - offset)
            if received < 0, [EINTR, EAGAIN, EWOULDBLOCK].contains(errno) { continue }
            guard received > 0 else {
                throw descriptor == standardInput ? BridgeError.disconnected : BridgeError.unavailable
            }
            offset += received
        }
    }
    return data
}

private func readFrame(from descriptor: Int32, until deadline: DispatchTime, monitorBrowser: Bool,
                       limit: Int = maximumFrameBytes) throws -> Data {
    let header = try readBytes(4, from: descriptor, until: deadline, monitorBrowser: monitorBrowser)
    let length = header.withUnsafeBytes { Int(UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self))) }
    guard (1...limit).contains(length) else { throw BridgeError.invalid }
    return try readBytes(length, from: descriptor, until: deadline, monitorBrowser: monitorBrowser)
}

private func writeFrame<T: Encodable>(_ value: T, to descriptor: Int32, until deadline: DispatchTime,
                                      limit: Int = maximumFrameBytes) throws {
    let data = try JSONEncoder().encode(value)
    guard (1...limit).contains(data.count) else { throw BridgeError.invalid }
    var length = UInt32(data.count).littleEndian
    var frame = withUnsafeBytes(of: &length) { Data($0) }
    frame.append(data)
    try frame.withUnsafeBytes { buffer in
        var offset = 0
        while offset < buffer.count {
            try waitFor(descriptor, events: Int16(POLLOUT), until: deadline, monitorBrowser: true)
            let sent = write(descriptor, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
            if sent < 0, [EINTR, EAGAIN, EWOULDBLOCK].contains(errno) { continue }
            guard sent > 0 else { throw BridgeError.unavailable }
            offset += sent
        }
    }
}

private func socketDirectory() throws -> String {
    #if ONLINE_SUBTITLE_BRIDGE_TEST
    if let directory = ProcessInfo.processInfo.environment["ONLINE_SUBTITLE_BRIDGE_TEST_DIRECTORY"] {
        return directory
    }
    #endif
    let size = confstr(_CS_DARWIN_USER_TEMP_DIR, nil, 0)
    guard size > 1 else { throw BridgeError.unavailable }
    var text = [CChar](repeating: 0, count: size)
    guard confstr(_CS_DARWIN_USER_TEMP_DIR, &text, size) == size,
          let directory = text.withUnsafeBufferPointer({ String(validatingCString: $0.baseAddress!) }) else {
        throw BridgeError.unavailable
    }
    return directory + (directory.hasSuffix("/") ? "" : "/") + "mh-companion"
}

private func socketPath() throws -> String {
    let directory = try socketDirectory()
    var info = stat()
    guard lstat(directory, &info) == 0, info.st_uid == geteuid(), info.st_mode & 0o177777 == 0o040700 else {
        throw BridgeError.unavailable
    }
    let endpoint = open(directory + "/endpoint", O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
    guard endpoint >= 0 else { throw BridgeError.unavailable }
    defer { close(endpoint) }
    guard fstat(endpoint, &info) == 0, info.st_uid == geteuid(),
          info.st_mode & 0o170000 == 0o100000, info.st_size == 37 else { throw BridgeError.unavailable }
    let data = try readBytes(37, from: endpoint, until: .now() + .seconds(1), monitorBrowser: true)
    guard let name = String(data: data, encoding: .ascii), name.hasSuffix(".sock"),
          name.utf8.prefix(32).allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
        throw BridgeError.unavailable
    }
    return directory + "/" + name
}

private func connectToMacHelper(until deadline: DispatchTime) throws -> Int32 {
    let path = try socketPath()
    var address = sockaddr_un()
    let pathBytes = Array(path.utf8CString)
    guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw BridgeError.unavailable }
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutableBytes(of: &address.sun_path) { buffer in buffer.copyBytes(from: pathBytes.map(UInt8.init(bitPattern:))) }
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw BridgeError.unavailable }
    do {
        try setNonblocking(descriptor)
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        if result < 0 {
            guard errno == EINPROGRESS else { throw BridgeError.unavailable }
            try waitFor(descriptor, events: Int16(POLLOUT), until: deadline, monitorBrowser: true)
            var connectionError: Int32 = 0
            var size = socklen_t(MemoryLayout.size(ofValue: connectionError))
            guard getsockopt(descriptor, SOL_SOCKET, SO_ERROR, &connectionError, &size) == 0,
                  connectionError == 0 else { throw BridgeError.unavailable }
        }
        var owner: uid_t = 0
        var group: gid_t = 0
        guard getpeereid(descriptor, &owner, &group) == 0, owner == geteuid() else { throw BridgeError.unavailable }
        return descriptor
    } catch {
        close(descriptor)
        throw error
    }
}

private func invoke(_ request: CommandRequest) throws -> CommandResponse {
    let connectionDeadline = DispatchTime.now() + .seconds(3)
    let macHelper = try connectToMacHelper(until: connectionDeadline)
    defer { close(macHelper) }
    let payload = try JSONEncoder().encode(request)
    guard payload.count <= maximumFrameBytes else { throw BridgeError.invalid }
    let invocation = ["type": "invoke", "extension": extensionID, "companion": chromeExtensionID,
                      "command": request.type.command, "payload": String(decoding: payload, as: UTF8.self)]
    try writeFrame(invocation, to: macHelper, until: connectionDeadline, limit: maximumBrokerFrameBytes)
    let timeout = request.type == .getSettings ? 5 : 65
    let response = try readFrame(from: macHelper, until: .now() + .seconds(timeout), monitorBrowser: true,
                                 limit: maximumBrokerFrameBytes)
    return try BrokerResponse.decode(response, for: request)
}

private func watchStatus() throws {
    let connectionDeadline = DispatchTime.now() + .seconds(3)
    let macHelper = try connectToMacHelper(until: connectionDeadline)
    defer { close(macHelper) }
    let subscription = ["type": "watchStatus", "extension": extensionID, "companion": chromeExtensionID]
    try writeFrame(subscription, to: macHelper, until: connectionDeadline)

    var deadline = DispatchTime.now() + .seconds(5)
    while true {
        let bytes = try readFrame(from: macHelper, until: deadline, monitorBrowser: true, limit: maximumStatusFrameBytes)
        try writeFrame(try StatusUpdate.decode(bytes), to: standardOutput, until: .now() + .seconds(2))
        // The status may remain unchanged indefinitely. Once a new frame
        // becomes readable, bound the time to finish reading it.
        try waitFor(macHelper, events: Int16(POLLIN), until: nil, monitorBrowser: true)
        deadline = .now() + .seconds(3)
    }
}

private func run() {
    guard CommandLine.arguments.dropFirst().first == allowedOrigin else { return }
    signal(SIGPIPE, SIG_IGN)
    do {
        try setNonblocking(standardInput)
        try setNonblocking(standardOutput)
        let response: CommandResponse
        do {
            let bytes = try readFrame(from: standardInput, until: .now() + .seconds(10), monitorBrowser: false)
            if bytes.count <= maximumStatusFrameBytes,
               (try? JSONDecoder().decode([String: String].self, from: bytes)) == statusRequest {
                // EOF on this port is the failure signal for a subscription.
                try? watchStatus()
                return
            }
            let request = try CommandRequest.decode(bytes)
            do {
                response = try invoke(request)
            } catch BridgeError.disconnected {
                return
            } catch {
                response = CommandResponse(error: .unavailable)
            }
        } catch BridgeError.invalid {
            response = CommandResponse(error: .invalid)
        }
        try writeFrame(response, to: standardOutput, until: .now() + .seconds(2))
    } catch {
        // Closing the connection cancels a running translation. Caption data
        // stays in memory, and stdout is reserved for Chrome's response frame.
    }
}

run()
