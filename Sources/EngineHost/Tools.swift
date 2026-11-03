import Foundation

/// Runs the person's own tools (gh, git, gpg, ssh-keygen, claude...) for setup checks. Lives in EngineHost
/// because this is the one area allowed to start programs.
enum Tools {
    struct Result: Sendable {
        let status: Int32
        let out: String
        let err: String
        var ok: Bool { status == 0 }
    }

    /// Runs `command args` with the person's PATH. `input` goes to stdin. Gives up after `timeout` seconds.
    static func run(
        _ command: String, _ args: [String], input: String? = nil, cwd: URL? = nil, env: [String: String] = [:], timeout: TimeInterval = 60
    ) async -> Result {
        let path = await ToolPath.shared.value()
        return await withCheckedContinuation { cont in
            DispatchQueue.global().async {
                cont.resume(returning: runSync(command, args, input: input, cwd: cwd, env: env, path: path, timeout: timeout))
            }
        }
    }

    private static func runSync(
        _ command: String, _ args: [String], input: String?, cwd: URL?, env: [String: String], path: String, timeout: TimeInterval
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
        var outData = Data()
        var errData = Data()
        let group = DispatchGroup()
        group.enter()
        group.enter()
        DispatchQueue.global().async {
            outData = out.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        DispatchQueue.global().async {
            errData = err.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        do { try p.run() } catch { return Result(status: 127, out: "", err: "\(command) isn't installed") }
        if let input { inp.fileHandleForWriting.write(Data(input.utf8)) }
        try? inp.fileHandleForWriting.close()
        let deadline = Date().addingTimeInterval(timeout)
        while p.isRunning && Date() < deadline { usleep(20_000) }
        if p.isRunning {
            p.terminate()
            p.waitUntilExit()
        }
        group.wait()
        let s = String(data: outData, encoding: .utf8) ?? ""
        let t = String(data: errData, encoding: .utf8) ?? ""
        return Result(status: p.terminationReason == .uncaughtSignal ? 124 : p.terminationStatus, out: s, err: t)
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
