import Foundation
import Security

/// Starts, watches and stops an engine: the only code in Forge that runs programs (lint rule `process-area`).
///
/// - One engine per project (`EngineHost.forProject`), each in its own folder with its own workflow file, store,
///   card folders and log; `shared` is the one in Forge's own folder (the project carried over from before).
/// - `ensureStarted()` is single-flight; callers racing at launch share one start.
/// - Never kills a healthy engine: a running engine is reused, not restarted.
/// - Watched: if the engine dies on its own it is started again, waiting longer after each crash.
/// - Stopped by draining: SIGTERM lets running agents finish (the engine's drain window), then SIGKILL.
actor EngineHost {
    static let shared = EngineHost(home: Paths.home, logs: Paths.logs)
    /// The sessions host: the same engine in its sessions mode (chats with agents), one per Mac.
    static let sessions = EngineHost(
        home: Paths.home.appendingPathComponent("sessions"), logs: Paths.logs.appendingPathComponent("sessions"), sessions: true)

    /// This engine's folder: its workflow file, its store and its card folders.
    let home: URL
    /// Where its log goes.
    let logs: URL

    /// Runs the engine's sessions mode (no workflow file, no board).
    let sessionsMode: Bool

    init(home: URL, logs: URL, sessions: Bool = false) {
        self.home = home
        self.logs = logs
        self.sessionsMode = sessions
    }

    nonisolated var workflow: URL { home.appendingPathComponent("WORKFLOW.md") }
    nonisolated var cards: URL { home.appendingPathComponent("workspaces") }

    private static let registry = HostRegistry()

    /// The engine of a project: `folder` is its folder under Forge's (`ProjectRecord.folder`); nil = Forge's own.
    static func forProject(folder: String?) -> EngineHost {
        guard let folder, !folder.isEmpty else { return shared }
        return registry.host(folder) {
            EngineHost(home: Paths.home.appendingPathComponent(folder), logs: Paths.logs.appendingPathComponent(folder))
        }
    }

    /// Every project engine made so far (not `shared`).
    static var made: [EngineHost] { registry.all }

    struct Connection: Sendable, Equatable {
        let port: Int
        let token: String
        let pid: Int32
        var client: EngineClient { EngineClient(port: port, token: token) }
    }

    enum Failure: Error, CustomStringConvertible {
        case notBundled(String)
        case noWorkflow
        case didNotStart(String)

        var description: String {
            switch self {
            case .notBundled(let p): return "the engine isn't inside the app (\(p))"
            case .noWorkflow: return "setup isn't finished yet"
            case .didNotStart(let why): return "the engine didn't start: \(why)"
            }
        }
    }

    /// Secrets and settings for the engine's environment (from the Keychain and setup). Set before starting.
    private var extraEnv: [String: String] = [:]
    private var process: Process?
    private var connection: Connection?
    private var starting: Task<Connection, Error>?
    private var stopping = false
    private var crashes = 0
    /// Why the engine isn't running, in words the app can show. Nil while it runs.
    private(set) var lastFailure: String?
    static let maxCrashes = 5
    private var observers: [@Sendable (Connection?) -> Void] = []

    func setEnvironment(_ env: [String: String]) { extraEnv = env }

    /// Called with the new connection after every (re)start, and with nil when the engine stops.
    func observe(_ f: @escaping @Sendable (Connection?) -> Void) { observers.append(f) }

    var current: Connection? { connection }

    func ensureStarted() async throws -> Connection {
        if let c = connection, let p = process, p.isRunning { return c }
        if let t = starting { return try await t.value }
        stopping = false
        let t = Task { try await self.launch() }
        starting = t
        defer { starting = nil }
        do {
            let c = try await t.value
            lastFailure = nil
            return c
        } catch {
            lastFailure = "\(error)"
            throw error
        }
    }

    private func launch() async throws -> Connection {
        let (node, script) = try EngineHost.locate()
        guard sessionsMode || FileManager.default.fileExists(atPath: workflow.path) else { throw Failure.noWorkflow }
        try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let token = EngineHost.newToken()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = ["--disable-warning=ExperimentalWarning", script]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = await ToolPath.shared.value()
        for (k, v) in extraEnv { env[k] = v }
        env["FORGE_API_TOKEN"] = token
        env["FORGE_HOME"] = Paths.home.path
        // The engine keeps its workflow and store here; the app's own commands (token renewal) still use Forge's.
        env["FORGE_ENGINE_HOME"] = home.path
        env["FORGE_LOG_FILE"] = logs.appendingPathComponent("engine.log").path
        if sessionsMode { env["FORGE_ENGINE_MODE"] = "sessions" }
        p.environment = env
        p.currentDirectoryURL = home
        let out = Pipe()
        p.standardOutput = out
        p.standardError = EngineHost.stderrLog(logs)
        p.terminationHandler = { [self] proc in
            Task { await self.exited(pid: proc.processIdentifier) }
        }
        try p.run()
        process = p
        guard let port = await EngineHost.readyPort(out, timeout: 30) else {
            p.terminate()
            throw Failure.didNotStart("no ready line within 30 s (see \(logs.path))")
        }
        let c = Connection(port: port, token: token, pid: p.processIdentifier)
        connection = c
        let healthyAt = Date()
        Task {
            try? await Task.sleep(nanoseconds: 60_000_000_000)
            self.markHealthy(pid: c.pid, since: healthyAt)
        }
        for f in observers { f(c) }
        return c
    }

    private func markHealthy(pid: Int32, since: Date) {
        if connection?.pid == pid { crashes = 0 }
    }

    private func exited(pid: Int32) async {
        guard connection?.pid == pid || process?.processIdentifier == pid else { return }
        connection = nil
        process = nil
        for f in observers { f(nil) }
        guard !stopping else { return }
        crashes += 1
        guard crashes <= EngineHost.maxCrashes else {
            lastFailure = "the engine stopped \(crashes) times in a row; see \(logs.path)"
            return
        }
        let wait = min(30.0, pow(2.0, Double(crashes - 1)))
        try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
        guard !stopping, connection == nil else { return }
        _ = try? await ensureStarted()
    }

    /// Stops the engine and waits for it: SIGTERM (it drains), then SIGKILL after `grace` seconds.
    func stop(grace: TimeInterval = 30) async {
        stopping = true
        guard let p = process, p.isRunning else { return }
        let pid = p.processIdentifier
        kill(pid, SIGTERM)
        let deadline = Date().addingTimeInterval(grace)
        while p.isRunning && Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        if p.isRunning { kill(pid, SIGKILL) }
        while p.isRunning { try? await Task.sleep(nanoseconds: 50_000_000) }
        connection = nil
        process = nil
    }

    // MARK: helpers

    /// The bundled Node and engine script. `FORGE_ENGINE_DIR` points at another copy (a developer's checkout).
    static func locate() throws -> (node: String, script: String) {
        let env = ProcessInfo.processInfo.environment
        let dir = env["FORGE_ENGINE_DIR"].map { URL(fileURLWithPath: $0) } ?? Bundle.main.resourceURL?.appendingPathComponent("engine")
        guard let dir else { throw Failure.notBundled("no resources folder") }
        let node = env["FORGE_NODE"] ?? dir.appendingPathComponent("node").path
        let script = dir.appendingPathComponent("dist/index.js").path
        for f in [node, script] where !FileManager.default.fileExists(atPath: f) { throw Failure.notBundled(f) }
        return (node, script)
    }

    static func newToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    private static func stderrLog(_ logs: URL) -> FileHandle? {
        let url = logs.appendingPathComponent("engine-stderr.log")
        if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
        let h = try? FileHandle(forWritingTo: url)
        _ = try? h?.seekToEnd()
        return h
    }

    /// Reads the engine's one stdout line, `FORGE_ENGINE_READY {"port":N}`.
    static func readyPort(_ pipe: Pipe, timeout: TimeInterval) async -> Int? {
        await withCheckedContinuation { (cont: CheckedContinuation<Int?, Never>) in
            let box = ReadyBox(cont)
            pipe.fileHandleForReading.readabilityHandler = { h in
                let data = h.availableData
                if data.isEmpty {
                    h.readabilityHandler = nil
                    box.finish(nil)
                    return
                }
                if let port = box.feed(data) {
                    h.readabilityHandler = nil
                    box.finish(port)
                }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                pipe.fileHandleForReading.readabilityHandler = nil
                box.finish(nil)
            }
        }
    }
}

/// Collects stdout until the ready line and resumes the waiter exactly once.
private final class ReadyBox: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer = Data()
    private var cont: CheckedContinuation<Int?, Never>?

    init(_ c: CheckedContinuation<Int?, Never>) { cont = c }

    func feed(_ d: Data) -> Int? {
        lock.lock()
        defer { lock.unlock() }
        buffer.append(d)
        guard let text = String(data: buffer, encoding: .utf8) else { return nil }
        for line in text.split(separator: "\n") where line.hasPrefix("FORGE_ENGINE_READY ") {
            let json = Data(line.dropFirst("FORGE_ENGINE_READY ".count).utf8)
            if let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any], let port = obj["port"] as? Int {
                return port
            }
        }
        return nil
    }

    func finish(_ v: Int?) {
        lock.lock()
        let c = cont
        cont = nil
        lock.unlock()
        c?.resume(returning: v)
    }
}

/// The project engines made so far, one per folder.
final class HostRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var hosts: [String: EngineHost] = [:]

    func host(_ key: String, make: () -> EngineHost) -> EngineHost {
        lock.lock()
        defer { lock.unlock() }
        if let h = hosts[key] { return h }
        let h = make()
        hosts[key] = h
        return h
    }

    var all: [EngineHost] {
        lock.lock()
        defer { lock.unlock() }
        return Array(hosts.values)
    }
}
