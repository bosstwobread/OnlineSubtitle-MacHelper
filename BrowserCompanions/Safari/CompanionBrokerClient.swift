import Darwin
import Foundation

// This adapter carries only the source-extension companion protocol. Worker
// commands, the meanings of payloads, and all grants are owned by MacHelper.
enum CompanionBridgeFailure: String, Error {
    case invalid, unavailable, disconnected, busy, failed

    var response: [String: Any] {
        ["ok": false, "error": self == .disconnected ? "unavailable" : rawValue]
    }
}

struct CompanionBridgeCaller {
    enum Browser: String {
        case chrome, edge, firefox, safari
    }

    let browser: Browser
    let identifier: String

    static func nativeMessaging(_ arguments: [String]) -> Self? {
        let prefix = "mac-helper-companion-"
        guard let executable = arguments.first.map({ URL(fileURLWithPath: $0).lastPathComponent }),
              executable.hasPrefix(prefix),
              let browser = Browser(rawValue: String(executable.dropFirst(prefix.count))) else { return nil }
        switch browser {
        case .chrome, .edge:
            let originPrefix = "chrome-extension://"
            guard arguments.count == 2, arguments[1].hasPrefix(originPrefix), arguments[1].hasSuffix("/") else {
                return nil
            }
            let identifier = String(arguments[1].dropFirst(originPrefix.count).dropLast())
            guard identifier.utf8.count == 32,
                  identifier.utf8.allSatisfy({ (97...112).contains($0) }) else { return nil }
            return Self(browser: browser, identifier: identifier)
        case .firefox:
            // Firefox passes its host manifest path followed by the add-on ID.
            guard arguments.count == 3, arguments[1].hasPrefix("/"),
                  arguments[1].hasSuffix("/com.localaibasetools.companion.json"),
                  matches(arguments[2], #"\A(?:[A-Za-z0-9._-]*@[A-Za-z0-9._-]+|\{[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}\})\z"#, limit: 80)
            else { return nil }
            return Self(browser: browser, identifier: arguments[2])
        case .safari:
            return nil
        }
    }

    static func safari(extensionBundleIdentifier: String) -> Self? {
        guard matches(extensionBundleIdentifier, #"\A[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+\z"#, limit: 128)
        else { return nil }
        return Self(browser: .safari, identifier: extensionBundleIdentifier)
    }
}

struct CompanionBridgeRequest {
    enum Operation: String {
        case invoke, watchStatus, getStatus
    }

    let operation: Operation
    let extensionID: String
    let command: String?
    let payload: String?

    init(json: [String: Any]) throws {
        guard let rawOperation = json["type"] as? String, let operation = Operation(rawValue: rawOperation),
              let identifier = json["extension"] as? String,
              matches(identifier, #"\A[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,7}\z"#, limit: 128) else {
            throw CompanionBridgeFailure.invalid
        }
        let keys = Set(json.keys)
        switch operation {
        case .invoke:
            guard keys == ["type", "extension", "command", "payload"], let command = json["command"] as? String,
                  matches(command, #"\A[a-z][a-z0-9-]{0,47}\z"#, limit: 48),
                  let payload = json["payload"] as? String, payload.utf8.count <= CompanionBrokerClient.maximumPayload
            else { throw CompanionBridgeFailure.invalid }
            self.command = command
            self.payload = payload
        case .watchStatus, .getStatus:
            guard keys == ["type", "extension"] else { throw CompanionBridgeFailure.invalid }
            command = nil
            payload = nil
        }
        self.operation = operation
        extensionID = identifier
    }

    func brokerMessage(for caller: CompanionBridgeCaller) throws -> Data {
        var fields = ["type": operation == .invoke ? "invoke" : "watchStatus", "extension": extensionID,
                      "browser": caller.browser.rawValue, "companion": caller.identifier]
        fields["command"] = command
        fields["payload"] = payload
        return try JSONSerialization.data(withJSONObject: fields, options: [.withoutEscapingSlashes])
    }
}

struct CompanionBrokerClient {
    static let maximumFrame = 128 * 1024
    static let maximumPayload = 32 * 1024
    static let maximumStatusFrame = 1_024
    static let maximumInvocationSeconds = 60
    var disconnectDescriptor: Int32?
    #if MACHELPER_COMPANION_TESTING
    var testDirectory = ProcessInfo.processInfo.environment["MACHELPER_COMPANION_TEST_DIRECTORY"]
    #endif

    // Safari's system native-message handler can use this one-shot adapter.
    // Its calling extension bundle supplies the identifier, never the message.
    static func safariReply(to json: [String: Any], extensionBundleIdentifier: String) throws -> [String: Any] {
        guard let caller = CompanionBridgeCaller.safari(extensionBundleIdentifier: extensionBundleIdentifier) else {
            throw CompanionBridgeFailure.invalid
        }
        let request = try CompanionBridgeRequest(json: json)
        guard request.operation != .watchStatus else { throw CompanionBridgeFailure.invalid }
        let client = Self()
        let descriptor = try client.open(request, as: caller)
        defer { Darwin.close(descriptor) }
        let reply = try client.readReply(for: request, from: descriptor)
        return try CompanionBridgeWire.object(reply)
    }

    func open(_ request: CompanionBridgeRequest, as caller: CompanionBridgeCaller) throws -> Int32 {
        let deadline = DispatchTime.now() + .seconds(3)
        let message = try request.brokerMessage(for: caller)
        let path = try socketPath(until: deadline)
        var address = sockaddr_un()
        let pathBytes = Array(path.utf8CString)
        guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            throw CompanionBridgeFailure.unavailable
        }
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            buffer.copyBytes(from: pathBytes.map(UInt8.init(bitPattern:)))
        }
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw CompanionBridgeFailure.unavailable }
        do {
            try CompanionBridgeWire.nonblocking(descriptor)
            var noSignal: Int32 = 1
            guard fcntl(descriptor, F_SETFD, FD_CLOEXEC) == 0,
                  setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size)) == 0
            else { throw CompanionBridgeFailure.unavailable }
            let result = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            if result < 0 {
                guard errno == EINPROGRESS else { throw CompanionBridgeFailure.unavailable }
                try CompanionBridgeWire.wait(descriptor, events: Int16(POLLOUT), until: deadline,
                                             disconnect: disconnectDescriptor)
                var connectionError: Int32 = 0
                var size = socklen_t(MemoryLayout<Int32>.size)
                guard getsockopt(descriptor, SOL_SOCKET, SO_ERROR, &connectionError, &size) == 0,
                      connectionError == 0 else { throw CompanionBridgeFailure.unavailable }
            }
            var owner: uid_t = 0
            var group: gid_t = 0
            guard getpeereid(descriptor, &owner, &group) == 0, owner == geteuid() else {
                throw CompanionBridgeFailure.unavailable
            }
            try CompanionBridgeWire.writeFrame(message, to: descriptor, until: deadline, disconnect: disconnectDescriptor)
            return descriptor
        } catch {
            Darwin.close(descriptor)
            throw error
        }
    }

    func readReply(for request: CompanionBridgeRequest, from descriptor: Int32,
                   deadline: DispatchTime? = nil) throws -> Data {
        let status = request.operation != .invoke
        let result = try CompanionBridgeWire.readFrame(
            from: descriptor, until: deadline ?? .now() + .seconds(status ? 5 : Self.maximumInvocationSeconds),
            limit: status ? Self.maximumStatusFrame : Self.maximumFrame, disconnect: disconnectDescriptor)
        guard let object = try? CompanionBridgeWire.object(result) else {
            throw CompanionBridgeFailure.unavailable
        }
        let keys = Set(object.keys)
        // Decode Bool strictly. JSONSerialization's NSNumber bridge
        // accepts 0/1 as Bool, whereas JSONDecoder requires a JSON boolean.
        let decoder = JSONDecoder()
        if status, keys == ["type", "enabled"] {
            struct Status: Decodable { let type: String; let enabled: Bool }
            guard let reply = try? decoder.decode(Status.self, from: result), reply.type == "status" else {
                throw CompanionBridgeFailure.unavailable
            }
        } else {
            struct Response: Decodable { let ok: Bool; let payload: String?; let error: String? }
            guard let reply = try? decoder.decode(Response.self, from: result) else {
                throw CompanionBridgeFailure.unavailable
            }
            if reply.ok {
                guard !status, keys == ["ok", "payload"], let payload = reply.payload,
                      payload.utf8.count <= Self.maximumPayload else { throw CompanionBridgeFailure.unavailable }
            } else {
                let expectedErrors: Set<String> = ["invalid", "unavailable", "busy", "failed"]
                guard keys == ["ok", "error"], let error = reply.error, expectedErrors.contains(error) else {
                    throw CompanionBridgeFailure.unavailable
                }
            }
        }
        return result
    }

    private func socketDirectory() throws -> String {
        #if MACHELPER_COMPANION_TESTING
        if let testDirectory { return testDirectory }
        #endif
        let length = confstr(_CS_DARWIN_USER_TEMP_DIR, nil, 0)
        guard (2...4096).contains(length) else { throw CompanionBridgeFailure.unavailable }
        var bytes = [CChar](repeating: 0, count: length)
        guard confstr(_CS_DARWIN_USER_TEMP_DIR, &bytes, length) == length,
              let root = bytes.withUnsafeBufferPointer({ String(validatingCString: $0.baseAddress!) }) else {
            throw CompanionBridgeFailure.unavailable
        }
        return URL(fileURLWithPath: root).appendingPathComponent("mh-companion", isDirectory: true).path
    }

    private func socketPath(until deadline: DispatchTime) throws -> String {
        let directory = try socketDirectory()
        let root = Darwin.open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard root >= 0 else { throw CompanionBridgeFailure.unavailable }
        defer { Darwin.close(root) }
        var metadata = stat()
        guard fstat(root, &metadata) == 0, metadata.st_uid == geteuid(),
              metadata.st_mode & (S_IFMT | 0o777) == S_IFDIR | 0o700 else {
            throw CompanionBridgeFailure.unavailable
        }
        let pointer = openat(root, "endpoint", O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
        guard pointer >= 0 else { throw CompanionBridgeFailure.unavailable }
        defer { Darwin.close(pointer) }
        guard fstat(pointer, &metadata) == 0, metadata.st_uid == geteuid(),
              metadata.st_mode & S_IFMT == S_IFREG, metadata.st_mode & 0o022 == 0, metadata.st_size == 37
        else { throw CompanionBridgeFailure.unavailable }
        let nameBytes = try CompanionBridgeWire.read(37, from: pointer, until: deadline, disconnect: disconnectDescriptor)
        guard let name = String(data: nameBytes, encoding: .ascii),
              matches(name, #"\A[a-f0-9]{32}\.sock\z"#, limit: 37),
              fstatat(root, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0,
              metadata.st_uid == geteuid(), metadata.st_mode & S_IFMT == S_IFSOCK
        else { throw CompanionBridgeFailure.unavailable }
        return directory + "/" + name
    }
}

enum CompanionBridgeWire {
    static func object(_ data: Data) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CompanionBridgeFailure.invalid
        }
        return object
    }

    static func nonblocking(_ descriptor: Int32) throws {
        let flags = fcntl(descriptor, F_GETFL)
        guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 else {
            throw CompanionBridgeFailure.unavailable
        }
    }

    static func wait(_ descriptor: Int32, events: Int16, until deadline: DispatchTime?, disconnect: Int32?) throws {
        var descriptors = [pollfd(fd: descriptor, events: events, revents: 0)]
        if let disconnect { descriptors.append(pollfd(fd: disconnect, events: Int16(POLLIN), revents: 0)) }
        while true {
            var timeout: Int32 = -1
            if let deadline {
                let now = DispatchTime.now().uptimeNanoseconds
                guard now < deadline.uptimeNanoseconds else { throw CompanionBridgeFailure.unavailable }
                timeout = Int32(clamping: (deadline.uptimeNanoseconds - now + 999_999) / 1_000_000)
            }
            let ready = descriptors.withUnsafeMutableBufferPointer { poll($0.baseAddress, nfds_t($0.count), timeout) }
            if ready < 0, errno == EINTR { continue }
            guard ready > 0 else { throw CompanionBridgeFailure.unavailable }
            if disconnect != nil, descriptors[1].revents != 0 { throw CompanionBridgeFailure.disconnected }
            guard descriptors[0].revents & events != 0 else { throw CompanionBridgeFailure.unavailable }
            return
        }
    }

    static func read(_ length: Int, from descriptor: Int32, until deadline: DispatchTime,
                     disconnect: Int32?) throws -> Data {
        var data = Data(count: length)
        try data.withUnsafeMutableBytes { buffer in
            var received = 0
            while received < length {
                try wait(descriptor, events: Int16(POLLIN), until: deadline, disconnect: disconnect)
                let count = Darwin.read(descriptor, buffer.baseAddress!.advanced(by: received), length - received)
                if count < 0, [EINTR, EAGAIN, EWOULDBLOCK].contains(errno) { continue }
                guard count > 0 else { throw CompanionBridgeFailure.unavailable }
                received += count
            }
        }
        return data
    }

    static func readFrame(from descriptor: Int32, until deadline: DispatchTime,
                          limit: Int = CompanionBrokerClient.maximumFrame, disconnect: Int32? = nil) throws -> Data {
        let header = try read(4, from: descriptor, until: deadline, disconnect: disconnect)
        let length = header.withUnsafeBytes { Int(UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self))) }
        guard (1...limit).contains(length) else { throw CompanionBridgeFailure.invalid }
        return try read(length, from: descriptor, until: deadline, disconnect: disconnect)
    }

    static func writeFrame(_ payload: Data, to descriptor: Int32, until deadline: DispatchTime,
                           disconnect: Int32?) throws {
        guard (1...CompanionBrokerClient.maximumFrame).contains(payload.count) else {
            throw CompanionBridgeFailure.invalid
        }
        var length = UInt32(payload.count).littleEndian
        var frame = withUnsafeBytes(of: &length) { Data($0) }
        frame.append(payload)
        try frame.withUnsafeBytes { buffer in
            var written = 0
            while written < buffer.count {
                try wait(descriptor, events: Int16(POLLOUT), until: deadline, disconnect: disconnect)
                let count = Darwin.write(descriptor, buffer.baseAddress!.advanced(by: written), buffer.count - written)
                if count < 0, [EINTR, EAGAIN, EWOULDBLOCK].contains(errno) { continue }
                guard count > 0 else { throw CompanionBridgeFailure.unavailable }
                written += count
            }
        }
    }
}

private func matches(_ text: String, _ pattern: String, limit: Int) -> Bool {
    text.utf8.count <= limit && text.range(of: pattern, options: .regularExpression) != nil
}
