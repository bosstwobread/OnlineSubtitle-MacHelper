import Darwin
import Foundation

enum SafariCompanionRelayGroup {
    static func directory(bundle: Bundle = .main) throws -> URL {
        guard let identifier = bundle.object(forInfoDictionaryKey: "OnlineSubtitleRelayGroup") as? String,
              identifier.utf8.count <= 128,
              identifier.range(of: #"\A(?:group|[A-Z0-9]{10})\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\z"#,
                               options: .regularExpression) != nil,
              let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier) else {
            throw CompanionBridgeFailure.unavailable
        }
        return url
    }
}

struct SafariCompanionRelayClient {
    let groupDirectory: URL

    func request(_ message: [String: Any], before deadline: DispatchTime) throws -> [String: Any] {
        let request = try CompanionBridgeRequest(json: message)
        let expires = deadline.uptimeNanoseconds
        guard request.extensionID == SafariRelayFiles.toolIdentifier, request.operation != .watchStatus,
              SafariRelayFiles.isPending(expires) else { throw CompanionBridgeFailure.invalid }

        let root = try SafariRelayFiles.root(groupDirectory, create: false)
        defer { Darwin.close(root) }
        try SafariRelayFiles.requireServer(in: root)
        let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let staging = "." + nonce
        guard mkdirat(root, staging, 0o700) == 0 else { throw CompanionBridgeFailure.unavailable }
        var name = staging
        let mailbox: Int32
        do { mailbox = try SafariRelayFiles.directory(in: root, name: staging) }
        catch {
            unlinkat(root, staging, AT_REMOVEDIR)
            throw error
        }
        defer {
            SafariRelayFiles.removeMailbox(in: root, name: name, mailbox: mailbox)
            Darwin.close(mailbox)
        }
        let envelope: [String: Any] = ["expires": String(expires), "message": message]
        let encoded = try JSONSerialization.data(withJSONObject: envelope, options: [.withoutEscapingSlashes])
        try SafariRelayFiles.write(encoded, name: "request", in: mailbox)
        let changes = try SafariRelayEvents(mailbox)
        guard renameatx_np(root, staging, root, nonce, UInt32(RENAME_EXCL)) == 0 else {
            throw CompanionBridgeFailure.unavailable
        }
        name = nonce
        while SafariRelayFiles.isPending(expires) {
            if let data = try SafariRelayFiles.read("reply", in: mailbox) {
                guard SafariRelayFiles.isPending(expires) else { throw CompanionBridgeFailure.unavailable }
                return try CompanionBridgeWire.object(data)
            }
            try changes.wait(until: deadline)
        }
        throw CompanionBridgeFailure.unavailable
    }
}

struct SafariCompanionRelayServer {
    let groupDirectory: URL
    let extensionBundleIdentifier: String

    func serve() throws {
        guard let caller = CompanionBridgeCaller.safari(extensionBundleIdentifier: extensionBundleIdentifier) else {
            throw CompanionBridgeFailure.invalid
        }
        let root = try SafariRelayFiles.root(groupDirectory, create: true)
        defer { Darwin.close(root) }
        let lock = try SafariRelayFiles.takeServerLock(in: root)
        defer { Darwin.close(lock) }
        let changes = try SafariRelayEvents(root)
        let slots = DispatchSemaphore(value: 4)
        let workers = DispatchQueue(label: "com.nelson007.online-subtitle.safari-relay", attributes: .concurrent)
        while true {
            for name in try SafariRelayFiles.mailboxes(in: root) {
                guard let mailbox = try? SafariRelayFiles.directory(in: root, name: name) else { continue }
                if SafariRelayFiles.expired(mailbox) {
                    SafariRelayFiles.removeMailbox(in: root, name: name, mailbox: mailbox)
                } else if !name.hasPrefix("."), slots.wait(timeout: .now()) == .success {
                    if SafariRelayFiles.claim(in: mailbox), let watcher = try? SafariRelayEvents(mailbox) {
                        workers.async {
                            defer { Darwin.close(mailbox); slots.signal() }
                            Self.respond(in: mailbox, watcher: watcher, as: caller)
                        }
                        continue
                    }
                    slots.signal()
                }
                Darwin.close(mailbox)
            }
            // Age orphaned files after a crash and resume if all workers were busy.
            try changes.wait(until: .now() + .seconds(2))
        }
    }

    private static func respond(in mailbox: Int32, watcher: SafariRelayEvents, as caller: CompanionBridgeCaller) {
        var reply: Data?
        var expires: UInt64?
        defer {
            if let reply, let expires, SafariRelayFiles.isPending(expires),
               SafariRelayFiles.requestExists(in: mailbox),
               (try? SafariRelayFiles.write(reply, name: "reply.tmp", in: mailbox)) != nil {
                _ = renameatx_np(mailbox, "reply.tmp", mailbox, "reply", UInt32(RENAME_EXCL))
            }
        }
        do {
            guard let data = try SafariRelayFiles.read("request", in: mailbox),
                  let envelope = try? CompanionBridgeWire.object(data), Set(envelope.keys) == ["expires", "message"],
                  let encodedExpiry = envelope["expires"] as? String, let expiry = UInt64(encodedExpiry),
                  SafariRelayFiles.isPending(expiry), let message = envelope["message"] as? [String: Any] else { return }
            expires = expiry
            let request = try CompanionBridgeRequest(json: message)
            guard request.extensionID == SafariRelayFiles.toolIdentifier, request.operation != .watchStatus else {
                throw CompanionBridgeFailure.invalid
            }
            let end = DispatchTime(uptimeNanoseconds: expiry)
            // Closing the cancel pipe's writer wakes the broker client. This
            // propagates client exit and expiry while the worker is running.
            let cancel = Pipe()
            let reason = DispatchSemaphore(value: 0)
            let stopped = DispatchSemaphore(value: 0)
            DispatchQueue.global(qos: .utility).async {
                defer {
                    try? cancel.fileHandleForWriting.close()
                    stopped.signal()
                }
                while SafariRelayFiles.isPending(expiry), SafariRelayFiles.requestExists(in: mailbox) {
                    let check = min(end, .now() + .milliseconds(100))
                    if reason.wait(timeout: check) == .success { return }
                    // Deletion also appears on the open directory descriptor.
                    if watcher.deleted { return }
                }
            }
            defer {
                reason.signal()
                _ = stopped.wait(timeout: .now() + .seconds(1))
                try? cancel.fileHandleForReading.close()
            }
            let client = CompanionBrokerClient(disconnectDescriptor: cancel.fileHandleForReading.fileDescriptor)
            let connection = try client.open(request, as: caller)
            defer { Darwin.close(connection) }
            let responseLimit = request.operation == .getStatus ? 4 : CompanionBrokerClient.maximumInvocationSeconds
            reply = try client.readReply(for: request, from: connection, deadline: min(end, .now() + .seconds(responseLimit)))
        } catch {
            reply = try? JSONSerialization.data(withJSONObject: ((error as? CompanionBridgeFailure) ?? .unavailable).response)
        }
    }
}

private enum SafariRelayFiles {
    static let toolIdentifier = "com.nelson007.online-subtitle"
    private static let directoryName = "OnlineSubtitleRelay"
    private static let maximumLifetime: UInt64 = 65_000_000_000
    private static let names = ["request", "claimed", "reply.tmp", "reply"]

    static func isPending(_ expires: UInt64) -> Bool {
        let now = DispatchTime.now().uptimeNanoseconds
        return expires > now && expires - now <= maximumLifetime
    }

    static func root(_ url: URL, create: Bool) throws -> Int32 {
        guard url.isFileURL else { throw CompanionBridgeFailure.unavailable }
        let group = Darwin.open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard group >= 0 else { throw CompanionBridgeFailure.unavailable }
        defer { Darwin.close(group) }
        var metadata = stat()
        guard fstat(group, &metadata) == 0, metadata.st_uid == geteuid() else {
            throw CompanionBridgeFailure.unavailable
        }
        if create, mkdirat(group, directoryName, 0o700) < 0, errno != EEXIST {
            throw CompanionBridgeFailure.unavailable
        }
        return try directory(in: group, name: directoryName)
    }

    static func directory(in parent: Int32, name: String) throws -> Int32 {
        let descriptor = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw CompanionBridgeFailure.unavailable }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0, metadata.st_uid == geteuid(),
              metadata.st_mode & (S_IFMT | 0o777) == S_IFDIR | 0o700 else {
            Darwin.close(descriptor)
            throw CompanionBridgeFailure.unavailable
        }
        return descriptor
    }

    static func write(_ data: Data, name: String, in directory: Int32) throws {
        guard (1...CompanionBrokerClient.maximumFrame).contains(data.count) else {
            throw CompanionBridgeFailure.invalid
        }
        let descriptor = openat(directory, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw CompanionBridgeFailure.unavailable }
        defer { Darwin.close(descriptor) }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw CompanionBridgeFailure.unavailable }
                offset += count
            }
        }
    }

    static func read(_ name: String, in directory: Int32) throws -> Data? {
        let descriptor = openat(directory, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
        if descriptor < 0, errno == ENOENT { return nil }
        guard descriptor >= 0 else { throw CompanionBridgeFailure.unavailable }
        defer { Darwin.close(descriptor) }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0, isPrivateFile(metadata),
              (1...Int64(CompanionBrokerClient.maximumFrame)).contains(metadata.st_size) else {
            throw CompanionBridgeFailure.unavailable
        }
        return try CompanionBridgeWire.read(Int(metadata.st_size), from: descriptor, until: .now() + .seconds(1),
                                            disconnect: nil)
    }

    static func takeServerLock(in root: Int32) throws -> Int32 {
        let lock = openat(root, "server", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0o600)
        guard lock >= 0 else { throw CompanionBridgeFailure.unavailable }
        var metadata = stat()
        guard fstat(lock, &metadata) == 0, isPrivateFile(metadata), flock(lock, LOCK_EX | LOCK_NB) == 0 else {
            Darwin.close(lock)
            throw CompanionBridgeFailure.unavailable
        }
        return lock
    }

    static func requireServer(in root: Int32) throws {
        let lock = openat(root, "server", O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard lock >= 0 else { throw CompanionBridgeFailure.unavailable }
        defer { Darwin.close(lock) }
        var metadata = stat()
        guard fstat(lock, &metadata) == 0, isPrivateFile(metadata), flock(lock, LOCK_SH | LOCK_NB) < 0,
              errno == EWOULDBLOCK else { throw CompanionBridgeFailure.unavailable }
    }

    static func claim(in mailbox: Int32) -> Bool {
        let descriptor = openat(mailbox, "claimed", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { return false }
        Darwin.close(descriptor)
        return true
    }

    static func mailboxes(in root: Int32) throws -> [String] {
        let scan = openat(root, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard scan >= 0 else { throw CompanionBridgeFailure.unavailable }
        guard let directory = fdopendir(scan) else { Darwin.close(scan); throw CompanionBridgeFailure.unavailable }
        defer { closedir(directory) }
        var result: [String] = []
        for _ in 0..<128 {
            guard let entry = readdir(directory) else { break }
            let name = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) {
                    String(validatingCString: $0)
                }
            }
            if let name, name.range(of: #"\A\.?[0-9a-f]{32}\z"#, options: .regularExpression) != nil {
                result.append(name)
            }
        }
        return result
    }

    static func expired(_ mailbox: Int32) -> Bool {
        var metadata = stat()
        guard fstat(mailbox, &metadata) == 0 else { return true }
        // The birth time handles requests from an earlier boot as well as
        // staging directories whose requests were never published.
        let age = time(nil) - metadata.st_birthtimespec.tv_sec
        return age >= 70 || age < -5
    }

    static func requestExists(in mailbox: Int32) -> Bool {
        var metadata = stat()
        return fstatat(mailbox, "request", &metadata, AT_SYMLINK_NOFOLLOW) == 0 && isPrivateFile(metadata)
    }

    static func removeMailbox(in root: Int32, name: String, mailbox: Int32) {
        var opened = stat()
        var current = stat()
        guard fstat(mailbox, &opened) == 0, fstatat(root, name, &current, AT_SYMLINK_NOFOLLOW) == 0,
              opened.st_ino == current.st_ino, opened.st_dev == current.st_dev else { return }
        for entry in names { unlinkat(mailbox, entry, 0) }
        _ = unlinkat(root, name, AT_REMOVEDIR)
    }

    private static func isPrivateFile(_ metadata: stat) -> Bool {
        metadata.st_uid == geteuid() && metadata.st_nlink == 1 &&
            metadata.st_mode & (S_IFMT | 0o777) == S_IFREG | 0o600
    }
}

private final class SafariRelayEvents: @unchecked Sendable {
    private let descriptor: Int32

    init(_ watched: Int32) throws {
        let queue = kqueue()
        guard queue >= 0 else { throw CompanionBridgeFailure.unavailable }
        let annotations = UInt32(NOTE_WRITE | NOTE_DELETE | NOTE_RENAME | NOTE_REVOKE)
        var event = kevent(ident: UInt(watched), filter: Int16(EVFILT_VNODE),
                           flags: UInt16(EV_ADD | EV_CLEAR), fflags: annotations, data: 0, udata: nil)
        guard kevent(queue, &event, 1, nil, 0, nil) == 0 else {
            Darwin.close(queue)
            throw CompanionBridgeFailure.unavailable
        }
        descriptor = queue
    }

    deinit { Darwin.close(descriptor) }

    var deleted: Bool {
        var event = kevent()
        var immediate = timespec()
        return kevent(descriptor, nil, 0, &event, 1, &immediate) == 1 && Self.wasDeleted(event)
    }

    func wait(until deadline: DispatchTime) throws {
        while true {
            let now = DispatchTime.now().uptimeNanoseconds
            guard now < deadline.uptimeNanoseconds else { return }
            let remaining = deadline.uptimeNanoseconds - now
            var timeout = timespec(tv_sec: Int(remaining / 1_000_000_000), tv_nsec: Int(remaining % 1_000_000_000))
            var event = kevent()
            let result = kevent(descriptor, nil, 0, &event, 1, &timeout)
            if result < 0, errno == EINTR { continue }
            guard result >= 0, result == 0 || !Self.wasDeleted(event) else { throw CompanionBridgeFailure.unavailable }
            return
        }
    }

    private static func wasDeleted(_ event: kevent) -> Bool {
        event.fflags & UInt32(NOTE_DELETE | NOTE_REVOKE) != 0
    }
}
