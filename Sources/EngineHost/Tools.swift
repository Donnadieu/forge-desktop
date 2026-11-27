import Foundation

/// Runs the person's own tools (gh, git, gpg, ssh-keygen, claude...) for setup checks. Lives in EngineHost
/// because this is the one area allowed to start programs.
enum Tools {
    struct Result: Sendable {
        let status: Int32
        let out: String
        let err: String
        var ok: Bool { status == 0 }
        /// Stopped at its time limit (or by a signal).
        var timedOut: Bool { status == 124 }

        /// What went wrong in the tool's own words: the last lines it printed, without `gh: ` and `error: ` prefixes.
        var reason: String {
            let text = err.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? out : err
            let lines = text.split(separator: "\n").map { line -> String in
                var l = line.trimmingCharacters(in: .whitespaces)
                for prefix in ["gh: ", "error: ", "fatal: ", "! ", "X "] where l.hasPrefix(prefix) { l = String(l.dropFirst(prefix.count)) }
                return l
            }.filter { !$0.isEmpty }
            let words = lines.suffix(2).joined(separator: " ")
            if words.isEmpty { return timedOut ? "it didn't finish in time." : "it stopped with code \(status) and said nothing." }
            return words.count > 400 ? String(words.prefix(400)) + "…" : words
        }
    }

    /// Runs `command args` with the person's PATH. `input` goes to stdin. Gives up after `timeout` seconds.
    static func run(
        _ command: String, _ args: [String], input: String? = nil, cwd: URL? = nil, env: [String: String] = [:], timeout: TimeInterval = 60
    ) async -> Result {
        let path = await ToolPath.shared.value()
        let stop = StopFlag()
        // Cancelling the calling task stops the program (the repo read's Cancel button).
        return await withTaskCancellationHandler {
            await withCheckedContinuation { cont in
                DispatchQueue.global().async {
                    cont.resume(returning: runSync(command, args, input: input, cwd: cwd, env: env, path: path, timeout: timeout, stop: stop))
                }
            }
        } onCancel: {
            stop.set()
        }
    }

    /// Set once from any thread to stop a running program.
    final class StopFlag: @unchecked Sendable {
        private let lock = NSLock()
        private var on = false
        func set() { lock.withLock { on = true } }
        var isSet: Bool { lock.withLock { on } }
    }

    private static func runSync(
        _ command: String, _ args: [String], input: String?, cwd: URL?, env: [String: String], path: String, timeout: TimeInterval,
        stop: StopFlag
    ) -> Result {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = [command] + args
        var e = ProcessInfo.processInfo.environment
        e["PATH"] = path
        e["GIT_TERMINAL_PROMPT"] = "0"
        e["GH_PROMPT_DISABLED"] = "1"
        for (k, v) in env { e[k] = v }
        p.environment = e
        if let cwd { p.currentDirectoryURL = cwd }
        let out = Pipe()
        let err = Pipe()
        let inp = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = inp
        let outData = Collected()
        let errData = Collected()
        let group = DispatchGroup()
        for (pipe, into) in [(out, outData), (err, errData)] {
            group.enter()
            DispatchQueue.global().async {
                let h = pipe.fileHandleForReading
                while true {
                    let chunk = h.availableData
                    if chunk.isEmpty { break }
                    into.append(chunk)
                }
                group.leave()
            }
        }
        do { try p.run() } catch { return Result(status: 127, out: "", err: "\(command) isn't installed") }
        if let input { inp.fileHandleForWriting.write(Data(input.utf8)) }
        try? inp.fileHandleForWriting.close()
        let deadline = Date().addingTimeInterval(timeout)
        while p.isRunning && Date() < deadline && !stop.isSet { usleep(20_000) }
        if p.isRunning {
            p.terminate()
            // A program that ignores the stop gets two seconds, then is killed.
            let grace = Date().addingTimeInterval(2)
            while p.isRunning && Date() < grace { usleep(20_000) }
            if p.isRunning { kill(p.processIdentifier, SIGKILL) }
            p.waitUntilExit()
        }
        // Something the program started can keep its output open after it ends (`cmd &`): wait at most two more
        // seconds for the rest of the output, never for that child.
        _ = group.wait(timeout: .now() + 2)
        let s = String(data: outData.value, encoding: .utf8) ?? ""
        let t = String(data: errData.value, encoding: .utf8) ?? ""
        return Result(status: p.terminationReason == .uncaughtSignal ? 124 : p.terminationStatus, out: s, err: t)
    }

    /// Output read on another thread, handed over under a lock.
    private final class Collected: @unchecked Sendable {
        private let lock = NSLock()
        private var data = Data()
        func append(_ d: Data) { lock.withLock { data.append(d) } }
        var value: Data { lock.withLock { data } }
    }

    /// Starts a program that outlives Forge (the updater's swap script). Its output is discarded.
    static func launchDetached(_ path: String, _ args: [String]) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
    }
}
