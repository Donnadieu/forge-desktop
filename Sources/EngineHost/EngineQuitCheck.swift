import Foundation

/// Part of `Forge --engine-check`: engines never outlive the app. Quitting stops every engine, also one still starting
/// and one a board asks for again while the quit drains it (BoardLink reconnects when its engine closes), and an app
/// killed outright (a crash, a force quit) leaves no engine behind: it stops by itself within seconds.
enum EngineQuitCheck {
    /// `Forge --engine-check-app <folder>`: a stand-in Forge for `appKilled`. Starts the engine of a project folder
    /// under FORGE_HOME, prints `ENGINE <pid>`, then waits to be killed.
    static func standInApp(_ args: [String]) -> Int32 {
        guard let i = args.firstIndex(of: "--engine-check-app"), i + 1 < args.count else { return 2 }
        let host = EngineHost.forProject(folder: args[i + 1])
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            await host.setEnvironment(["LINEAR_API_KEY": "engine-check-not-a-key"])
            if let c = try? await host.ensureStarted() {
                print("ENGINE \(c.pid)")
                fflush(stdout)
            } else {
                print("NO ENGINE \(await host.lastFailure ?? "")")
                fflush(stdout)
                done.signal()
            }
        }
        done.wait()
        return 1
    }

    /// The app is killed with SIGKILL (no quit runs): its engine must stop by itself.
    static func appKilled(_ check: (String, Bool) -> Void) async {
        let folder = "projects/engine-check-killed"
        let home = Paths.home.appendingPathComponent(folder)
        try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try? EngineCheck.workflow(home).write(to: home.appendingPathComponent("WORKFLOW.md"), atomically: true, encoding: .utf8)
        guard let exe = Bundle.main.executablePath else { return check("the stand-in app can start", false) }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = ["--engine-check-app", folder]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return check("the stand-in app can start", false) }
        guard let engine = firstPid(out, timeout: 40) else {
            kill(p.processIdentifier, SIGKILL)
            return check("the stand-in app starts its engine", false)
        }
        kill(p.processIdentifier, SIGKILL)
        let t0 = Date()
        while kill(engine, 0) == 0 && Date().timeIntervalSince(t0) < 4 { try? await Task.sleep(nanoseconds: 100_000_000) }
        let gone = kill(engine, 0) != 0
        if !gone { kill(engine, SIGKILL) }
        check("an engine stops by itself once Forge is killed (\(String(format: "%.1f", Date().timeIntervalSince(t0))) s)", gone)
    }

    /// Quitting: every engine stops, and none starts again. Runs last: after it this process starts no engine.
    static func quitting(_ check: (String, Bool) -> Void) async {
        let a = EngineHost.forProject(folder: "projects/engine-check-quit-a")
        let b = EngineHost.forProject(folder: "projects/engine-check-quit-b")
        let launched = Pids()
        for h in [a, b] {
            try? FileManager.default.createDirectory(at: h.home, withIntermediateDirectories: true)
            try? EngineCheck.workflow(h.home).write(to: h.workflow, atomically: true, encoding: .utf8)
            await h.setEnvironment(["LINEAR_API_KEY": "engine-check-not-a-key"])
            await h.observe { c in if let c { launched.add(c.pid) } }
        }
        guard let first = try? await a.ensureStarted() else { return check("an engine starts before the quit", false) }
        // B is still starting when the quit begins; A's board asks for its engine again the moment it closes.
        let starting = Task { try? await b.ensureStarted() }
        let reconnect = Task {
            while !Task.isCancelled {
                _ = try? await a.ensureStarted()
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        try? await Task.sleep(nanoseconds: 20_000_000)
        let t0 = Date()
        await EngineHost.stopAll()
        let took = Date().timeIntervalSince(t0)
        _ = await starting.value
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        reconnect.cancel()
        let left = launched.all.filter { kill($0, 0) == 0 }
        for pid in left { kill(pid, SIGKILL) }
        check("quitting stops every engine at once (\(Int(took)) s)", kill(first.pid, 0) != 0 && took < 25)
        check("no engine runs after the quit, not one still starting or asked for again (\(left))", left.isEmpty)
        check("a start asked for after the quit is refused", (try? await b.ensureStarted()) == nil)
    }

    /// The first `ENGINE <pid>` line on `pipe`, or nil after `timeout` seconds.
    private static func firstPid(_ pipe: Pipe, timeout: TimeInterval) -> Int32? {
        let found = Pids()
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            var text = ""
            while true {
                let d = pipe.fileHandleForReading.availableData
                if d.isEmpty { break }
                text += String(decoding: d, as: UTF8.self)
                if let line = text.split(separator: "\n").first(where: { $0.hasPrefix("ENGINE ") }),
                    let pid = Int32(line.dropFirst("ENGINE ".count))
                {
                    found.add(pid)
                    break
                }
                if text.contains("NO ENGINE") { break }
            }
            done.signal()
        }
        _ = done.wait(timeout: .now() + timeout)
        return found.all.first
    }

    private final class Pids: @unchecked Sendable {
        private let lock = NSLock()
        private var pids: [Int32] = []
        func add(_ p: Int32) {
            lock.lock()
            pids.append(p)
            lock.unlock()
        }
        var all: [Int32] {
            lock.lock()
            defer { lock.unlock() }
            return pids
        }
    }
}
