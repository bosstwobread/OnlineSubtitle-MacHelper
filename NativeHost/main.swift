import Darwin
import Foundation

private let allowedOrigin = "chrome-extension://ndmbmmhddeibbojclldpaabmkcielfmj/"
private let maximumFrameBytes = 32 * 1024
private let standardInput = STDIN_FILENO
private let standardOutput = STDOUT_FILENO

private enum BridgeError: Error {
    case disconnected, invalid, unavailable
}

private enum TranslationError: String, Codable {
    case unavailable, busy, model, translation, invalid
}

private struct Cue: Codable {
    let id: Int
    let text: String

    func isValid(textLimit: Int) -> Bool {
        (1...9_007_199_254_740_991).contains(id) && !text.contains("\0") &&
            !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && text.utf8.count <= textLimit
    }
}

private struct TranslationRequest: Codable {
    let type: String
    let cues: [Cue]

    static func decode(_ data: Data) throws -> Self {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["type", "cues"], let rawCues = object["cues"] as? [[String: Any]],
              rawCues.allSatisfy({ Set($0.keys) == ["id", "text"] }),
              let request = try? JSONDecoder().decode(Self.self, from: data), request.type == "translate",
              (1...8).contains(request.cues.count), request.cues.allSatisfy({ $0.isValid(textLimit: 1000) }),
              Set(request.cues.map(\.id)).count == request.cues.count else { throw BridgeError.invalid }
        return request
    }
}

private struct TranslationResponse: Codable {
    let ok: Bool
    let translations: [Cue]?
    let error: TranslationError?

    init(error: TranslationError) {
        ok = false
        translations = nil
        self.error = error
    }

    static func decode(_ data: Data, for request: TranslationRequest) throws -> Self {
        guard let response = try? JSONDecoder().decode(Self.self, from: data) else { throw BridgeError.unavailable }
        if response.ok {
            guard response.error == nil, let translations = response.translations,
                  translations.count == request.cues.count, translations.allSatisfy({ $0.isValid(textLimit: 2000) }),
                  Set(translations.map(\.id)) == Set(request.cues.map(\.id)) else { throw BridgeError.unavailable }
        } else {
            guard response.error != nil, response.translations == nil else { throw BridgeError.unavailable }
        }
        return response
    }
}

private func waitFor(_ descriptor: Int32, events: Int16, until deadline: DispatchTime,
                     monitorBrowser: Bool) throws {
    var watched = [pollfd(fd: descriptor, events: events, revents: 0)]
    if monitorBrowser { watched.append(pollfd(fd: standardInput, events: Int16(POLLIN), revents: 0)) }
    while true {
        let now = DispatchTime.now().uptimeNanoseconds
        guard now < deadline.uptimeNanoseconds else { throw BridgeError.unavailable }
        let remaining = deadline.uptimeNanoseconds - now
        let milliseconds = Int32(clamping: (remaining + 999_999) / 1_000_000)
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

private func readFrame(from descriptor: Int32, until deadline: DispatchTime, monitorBrowser: Bool) throws -> Data {
    let header = try readBytes(4, from: descriptor, until: deadline, monitorBrowser: monitorBrowser)
    let length = header.withUnsafeBytes { Int(UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self))) }
    guard (1...maximumFrameBytes).contains(length) else { throw BridgeError.invalid }
    return try readBytes(length, from: descriptor, until: deadline, monitorBrowser: monitorBrowser)
}

private func writeFrame<T: Encodable>(_ value: T, to descriptor: Int32, until deadline: DispatchTime) throws {
    let data = try JSONEncoder().encode(value)
    guard (1...maximumFrameBytes).contains(data.count) else { throw BridgeError.invalid }
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
    return directory + (directory.hasSuffix("/") ? "" : "/") + "online-subtitle"
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

private func connectToWorker(until deadline: DispatchTime) throws -> Int32 {
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

private func translate(_ request: TranslationRequest) throws -> TranslationResponse {
    let connectionDeadline = DispatchTime.now() + .seconds(3)
    let worker = try connectToWorker(until: connectionDeadline)
    defer { close(worker) }
    try writeFrame(request, to: worker, until: connectionDeadline)
    let response = try readFrame(from: worker, until: .now() + .seconds(65), monitorBrowser: true)
    return try TranslationResponse.decode(response, for: request)
}

private func run() {
    guard CommandLine.arguments.dropFirst().first == allowedOrigin else { return }
    signal(SIGPIPE, SIG_IGN)
    do {
        try setNonblocking(standardInput)
        try setNonblocking(standardOutput)
        let response: TranslationResponse
        do {
            let bytes = try readFrame(from: standardInput, until: .now() + .seconds(10), monitorBrowser: false)
            let request = try TranslationRequest.decode(bytes)
            do {
                response = try translate(request)
            } catch BridgeError.disconnected {
                return
            } catch {
                response = TranslationResponse(error: .unavailable)
            }
        } catch BridgeError.invalid {
            response = TranslationResponse(error: .invalid)
        }
        try writeFrame(response, to: standardOutput, until: .now() + .seconds(2))
    } catch {
        // Closing the connection cancels a running translation. Caption data
        // stays in memory, and stdout is reserved for Chrome's response frame.
    }
}

run()
