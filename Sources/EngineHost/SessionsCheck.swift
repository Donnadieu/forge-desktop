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
        await setupCheck(client, local: local, scratch: scratch, ok)
        await questionCheck(client, local: local, frames: frames, ok)
        return failed == 0 ? 0 : 1
    }

    /// The agent's question through the real host (Omar's ATC-1742 Chat 2, Nov 12): a message sent from the box while
    /// it waits is its answer, and Stop ends a turn whose question waits.
    private static func questionCheck(_ client: SessionsClient, local: URL, frames: Frames, _ ok: (String, Bool) -> Void) async {
        func asked(_ chat: String, times: Int = 1) async -> Bool {
            for _ in 0..<50 {
                if Set(frames.events.filter { $0.chatId == chat && $0.kind == "question" }.map(\.id)).count >= times { return true }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            return false
        }
        func last(_ chat: String) async -> Sessions.Turn? { (try? await client.turns(chat: chat))?.turns.last }
        let s = try? await client.create([
            "workspaceId": "ws-check", "repo": "acme/check", "local": local.path, "base": "main", "prefix": "sam",
            "message": "ask me", "model": "haiku", "effort": "low",
        ])
        guard let chat = s?.chats.first?.id, await asked(chat) else { return ok("the agent asks its question", false) }
        try? await client.send(chat: chat, text: "blue", queue: false)
        for _ in 0..<30 where await last(chat)?.status != "done" { try? await Task.sleep(nanoseconds: 100_000_000) }
        let t = await last(chat)
        ok(
            "a message sent while the question waits arrives as its answer",
            t?.status == "done" && t?.events.last?.text == "answered: Which colour?=blue; Which size?=blue")
        let q = t?.events.first { $0.kind == "question" }
        ok(
            "the question shows it as his answer, not a stuck steer",
            q?.data?["typed"]?.string == "blue" && t?.events.contains { $0.name == "steered" } == false)
        try? await client.send(chat: chat, text: "ask me", queue: false)
        guard await asked(chat, times: 2) else { return ok("the agent asks again", false) }
        try? await client.stop(chat: chat)
        for _ in 0..<30 where await last(chat)?.status == "working" { try? await Task.sleep(nanoseconds: 100_000_000) }
        ok("Stop ends a turn whose question waits", await last(chat)?.status == "stopped")
    }

    /// Workspace setup through the real host: the app's payload, a git-ignored file copied in, the setup script run
    /// with the workspace's variables (the secret masked in its output), and no secret anywhere in the host's folder.
    private static func setupCheck(_ client: SessionsClient, local: URL, scratch: URL, _ ok: (String, Bool) -> Void) async {
        let secret = "sk_sessions_check_\(UUID().uuidString.prefix(8))"
        try? "*.key\n".write(to: local.appendingPathComponent(".gitignore"), atomically: true, encoding: .utf8)
        _ = sh(["git", "add", ".gitignore"], in: local)
        _ = sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "ignore"], in: local)
        _ = sh(["git", "push", "-q", "origin", "HEAD:main"], in: local)
        try? "master-key".write(to: local.appendingPathComponent("master.key"), atomically: true, encoding: .utf8)
        let secrets = MemorySecrets()
        let env = WorkspaceEnv.save(
            [EnvRow(key: "APP_MODE", value: "check", secret: false), EnvRow(key: "API_KEY", value: secret, secret: true)], workspace: "ws-setup",
            old: [], secrets: secrets)
        let setup = WorkspaceSetup(
            copy: ["master.key"], setupScript: "cat master.key; echo \" mode=$APP_MODE key=$API_KEY\"", cleanupScript: nil, env: env)
        let pushed = (try? await client.workspaceSetup("ws-setup", setup.payload(workspace: "ws-setup", secrets: secrets))) != nil
        ok("the host takes a workspace's setup", pushed)
        let s = try? await client.create([
            "workspaceId": "ws-setup", "repo": "acme/check", "local": local.path, "base": "main", "prefix": "",
            "message": "set up", "model": "haiku", "effort": "low",
        ])
        var run = s?.setup
        for _ in 0..<100 where run?.state == "running" {
            try? await Task.sleep(nanoseconds: 100_000_000)
            run = (try? await client.sessions())?.first { $0.id == s?.id }?.setup
        }
        ok("a new session's folder gets the git-ignored file", s.map { FileManager.default.fileExists(atPath: $0.folder + "/master.key") } == true)
        ok(
            "its setup script ran there with the workspace's variables, the secret masked",
            run?.state == "done" && run?.output.contains("master-key mode=check key=\(WorkspaceEnv.mask)") == true)
        let home = Paths.home.path
        let leaked = FileManager.default.enumerator(atPath: home)?.contains { item in
            guard let p = item as? String, let d = FileManager.default.contents(atPath: home + "/" + p) else { return false }
            return d.range(of: Data(secret.utf8)) != nil
        }
        ok("the secret value is in no file of the host's folder", leaked == false)
        guard let chat = s?.chats.first else { return ok("the new session has a chat", false) }
        for _ in 0..<50 {
            if (try? await client.turns(chat: chat.id))?.turns.first?.status == "done" { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        let long = String(repeating: "a long log line\n", count: 400)
        try? await client.send(chat: chat.id, text: "read this", queue: false, texts: [["name": "Pasted text.txt", "text": long]])
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        let sent = (try? await client.turns(chat: chat.id))?.turns.last?.userText ?? ""
        let path = sent.split(separator: "\n").first { $0.hasPrefix("[text: ") }.map { String($0.dropFirst(7).dropLast()) }
        ok("a long paste reaches the host as a .txt file beside the chat", path.flatMap { try? String(contentsOfFile: $0, encoding: .utf8) } == long)
    }
}
