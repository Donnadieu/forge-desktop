import Foundation

/// `Forge --engine-check`: starts the bundled engine for real in a scratch folder and proves the promises
/// the app relies on. No network: the board points at a closed local port. Used by tools/preflight.sh.
enum EngineCheck {
    static func run() -> Int32 {
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("forge-engine-check-\(getpid())")
        try? FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        setenv("FORGE_HOME", scratch.path, 1)
        defer { try? FileManager.default.removeItem(at: scratch) }
        let workflow = """
            ---
            tracker:
              kind: linear
              project_slug: engine-check
              endpoint: http://127.0.0.1:9/graphql
            workspace:
              root: \(scratch.path)/workspaces
            polling:
              interval_ms: 60000
            ---
            Engine check for {{ issue.identifier }}
            """
        try? workflow.write(to: Paths.workflow, atomically: true, encoding: .utf8)

        let done = DispatchSemaphore(value: 0)
        let result = Box()
        Task.detached {
            result.failed = await checks()
            done.signal()
        }
        if done.wait(timeout: .now() + 90) == .timedOut {
            print("✗ the engine check took longer than 90 s")
            return 1
        }
        print(result.failed == 0 ? "engine check: all passed" : "engine check: \(result.failed) failed")
        return result.failed == 0 ? 0 : 1
    }

    private final class Box: @unchecked Sendable { var failed = 0 }

    private static func checks() async -> Int {
        var failed = 0
        func check(_ name: String, _ ok: Bool) {
            print("\(ok ? "✓" : "✗") \(name)")
            if !ok { failed += 1 }
        }
        let host = EngineHost.shared
        await host.setEnvironment(["LINEAR_API_KEY": "engine-check-not-a-key"])
        let restarted = Restarts()
        await host.observe { c in if let c { restarted.add(c.pid) } }

        async let a = try? host.ensureStarted()
        async let b = try? host.ensureStarted()
        let (first, second) = await (a, b)
        guard let c = first else {
            check("the engine starts (\(await host.lastFailure ?? "unknown"))", false)
            return failed
        }
        check("the engine starts and reports its port", c.port > 0)
        check("two starts at once share one engine", second?.pid == c.pid)
        check("the API listens on 127.0.0.1 with a long launch token", c.token.count >= 64)

        let refused = await (try? c.client.call("/api/v1/state", withToken: false)) == nil
        check("a request without the launch token is refused", refused)
        let state = try? await c.client.state()
        check("the board reads as stopped at first", state?.status == "stopped")

        let frames = Frames()
        let ws = c.client.live(onState: { frames.add($0) }, onClose: {})
        check("the live stream sends the state at once", await frames.wait { _ in true })
        try? await c.client.start()
        check("Start is pushed live as running", await frames.wait { $0.status == "running" })
        ws.cancel(with: .goingAway, reason: nil)

        let again = try? await host.ensureStarted()
        check("asking again reuses the healthy engine", again?.pid == c.pid)

        kill(c.pid, SIGKILL)
        var back: EngineHost.Connection?
        for _ in 0..<100 {
            try? await Task.sleep(nanoseconds: 100_000_000)
            if let now = await host.current, now.pid != c.pid {
                back = now
                break
            }
        }
        check("a crashed engine is started again", back != nil)
        let afterCrash = try? await back?.client.state()
        check("after a crash it comes back the way it was left (running)", afterCrash?.status == "running")

        let pid = back?.pid ?? c.pid
        let t0 = Date()
        await host.stop(grace: 20)
        check("Stop drains and ends the engine", kill(pid, 0) != 0)
        check("Stop doesn't hang (\(Int(Date().timeIntervalSince(t0))) s)", Date().timeIntervalSince(t0) < 20)
        return failed
    }

    private final class Restarts: @unchecked Sendable {
        private let lock = NSLock()
        private var pids: [Int32] = []
        func add(_ p: Int32) {
            lock.lock()
            pids.append(p)
            lock.unlock()
        }
    }

    private final class Frames: @unchecked Sendable {
        private let lock = NSLock()
        private var seen: [EngineState] = []
        func add(_ s: EngineState) {
            lock.lock()
            seen.append(s)
            lock.unlock()
        }
        func has(_ ok: (EngineState) -> Bool) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            return seen.contains(where: ok)
        }
        func wait(_ ok: @escaping (EngineState) -> Bool) async -> Bool {
            for _ in 0..<100 {
                if has(ok) { return true }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            return false
        }
    }
}
