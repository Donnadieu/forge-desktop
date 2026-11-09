import Foundation

/// `Forge --sessions-check`: starts the real sessions host (the bundled engine in its sessions mode) in a scratch
/// folder with a stand-in agent, and proves the app's side of a chat end to end: a session made from a local
/// checkout, the live stream decoding, a steer landing in the running turn, a queued message waiting, Stop, the
/// turns read back, and the changes. Set `FORGE_CLAUDE_COMMAND` to the stand-in (engine/test/fixtures/sessions).
enum SessionsCheck {
    static func run() -> Int32 {
        let done = DispatchSemaphore(value: 0)
        var code: Int32 = 1
        Task.detached {
            code = await check()
            done.signal()
        }
        done.wait()
        return code
    }

    private static func sh(_ args: [String], in dir: URL) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = args
        p.currentDirectoryURL = dir
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }

    final class Frames: @unchecked Sendable {
        private let lock = NSLock()
        private var all: [Sessions.Frame] = []
        func add(_ f: Sessions.Frame) { lock.withLock { all.append(f) } }
        var events: [Sessions.Event] {
            lock.withLock { all.compactMap { if case .event(let e) = $0 { return e } else { return nil } } }
        }
        var count: Int { lock.withLock { all.count } }
    }

    private static func check() async -> Int32 {
        var failed = 0
        func ok(_ name: String, _ pass: Bool) {
            print("\(pass ? "✓" : "✗") \(name)")
            if !pass { failed += 1 }
        }
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("forge-sessions-check-\(UUID().uuidString.prefix(8))")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let bare = scratch.appendingPathComponent("origin.git")
        let local = scratch.appendingPathComponent("checkout")
        try? FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        let made =
            sh(["git", "init", "-q", "--bare", "-b", "main", bare.path], in: scratch)
            && sh(["git", "clone", "-q", bare.path, local.path], in: scratch)
            && sh(
                ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "start"],
                in: local)
            && sh(["git", "push", "-q", "origin", "HEAD:main"], in: local)
        ok("a scratch repo with an origin", made)
        let host = EngineHost.sessions
        guard let c = try? await host.ensureStarted() else {
            ok("the sessions host starts", false)
            return 1
        }
        defer { Task { await host.stop() } }
        ok("the sessions host starts and reports its port", c.port > 0)
        let client = SessionsClient(port: c.port, token: c.token)
        let bad = SessionsClient(port: c.port, token: "wrong-token-wrong-token-wrong-token-1234")
        ok("a request without the launch token is refused", (try? await bad.sessions()) == nil)
        let frames = Frames()
        let live = client.live(onFrame: { frames.add($0) }, onClose: {})
        defer { live.cancel() }
        let s = try? await client.create([
            "workspaceId": "ws-check", "repo": "acme/check", "local": local.path, "base": "main", "prefix": "sam",
            "message": "hello", "model": "haiku", "effort": "low",
        ])
        ok("a session is made from a local checkout, on its own branch", s?.branch == "sam/hello" && s?.folder.contains("/folders/") == true)
        guard let s, let chat = s.chats.first else { return 1 }
        try? await Task.sleep(nanoseconds: 150_000_000)
        try? await client.send(chat: chat.id, text: "change course", queue: false)
        try? await client.send(chat: chat.id, text: "later", queue: true)
        try? await Task.sleep(nanoseconds: 2_500_000_000)
        let texts = frames.events.filter { $0.kind == "text" }.map(\.text)
        ok("the live stream decodes sessions, turns and events", frames.count > 3 && !frames.events.isEmpty)
        ok("a steer lands in the running turn", texts.contains("steered: change course"))
        ok("a queued message runs as the next turn", texts.contains("answer: later"))
        let turns = try? await client.turns(chat: chat.id)
        ok("the turns read back in order", turns?.turns.map(\.userText) == ["hello", "later"])
        try? await client.send(chat: chat.id, text: "one more", queue: false)
        try? await Task.sleep(nanoseconds: 100_000_000)
        try? await client.stop(chat: chat.id)
        try? await Task.sleep(nanoseconds: 800_000_000)
        let after = try? await client.turns(chat: chat.id)
        ok("Stop ends the running turn", after?.turns.last?.status == "stopped")
        let files = try? await client.changes(session: s.id)
        ok("the changes read back (none yet)", files?.isEmpty == true)
        return failed == 0 ? 0 : 1
    }
}
