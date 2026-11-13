import Darwin
import Foundation

/// A shell on a pseudo-terminal: the session terminal's process (Omar, Nov 12). Started with `forkpty` in the
/// session's folder with the environment given, read on a background queue, resized with TIOCSWINSZ, and ended with
/// SIGHUP to its whole process group (SIGKILL a second later if it's still there). Here because only EngineHost
/// starts programs.
final class TerminalProcess: @unchecked Sendable {
    let pid: pid_t
    private let master: Int32
    private let queue = DispatchQueue(label: "forge.terminal")
    private var reader: DispatchSourceRead?
    private var exitWatch: DispatchSourceProcess?
    private let lock = NSLock()
    private var ended = false

    /// Called on the main queue with what the shell printed, and once when it exits.
    var onOutput: (([UInt8]) -> Void)?
    var onExit: (() -> Void)?

    private init(pid: pid_t, master: Int32) {
        self.pid = pid
        self.master = master
    }

    /// The person's login shell (their `SHELL`, else zsh).
    static var loginShell: String {
        let s = ProcessInfo.processInfo.environment["SHELL"] ?? ""
        return s.hasPrefix("/") && FileManager.default.isExecutableFile(atPath: s) ? s : "/bin/zsh"
    }

    /// The shell's environment: the person's, without Forge's own launch variables, plus `extra` and a terminal type.
    static func environment(folder: String, extra: [String: String]) -> [String: String] {
        var env = ProcessInfo.processInfo.environment.filter { !$0.key.hasPrefix("FORGE_") && !$0.key.hasPrefix("GIT_CONFIG_") }
        for (k, v) in extra { env[k] = v }
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["PWD"] = folder
        if env["LANG"] == nil { env["LANG"] = "en_US.UTF-8" }
        return env
    }

    /// Starts `shell` as a login shell in `folder`. Nil when the folder isn't there or the PTY can't be made.
    static func start(shell: String, folder: String, env: [String: String], cols: Int, rows: Int) -> TerminalProcess? {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: folder, isDirectory: &isDir), isDir.boolValue else { return nil }
        // Everything the child touches is made before the fork: it may only call chdir, signal, sigprocmask, execve
        // and _exit.
        let name = "-" + (shell as NSString).lastPathComponent
        let argv = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(capacity: 2)
        argv[0] = strdup(name)
        argv[1] = nil
        let pairs = env.map { "\($0.key)=\($0.value)" }
        let envp = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(capacity: pairs.count + 1)
        for (i, p) in pairs.enumerated() { envp[i] = strdup(p) }
        envp[pairs.count] = nil
        let path = strdup(shell)
        let dir = strdup(folder)
        defer {
            free(argv[0])
            argv.deallocate()
            for i in 0..<pairs.count { free(envp[i]) }
            envp.deallocate()
            free(path)
            free(dir)
        }
        var master: Int32 = -1
        var size = winsize(ws_row: UInt16(clamping: rows), ws_col: UInt16(clamping: cols), ws_xpixel: 0, ws_ypixel: 0)
        var noSignalsBlocked = sigset_t()
        sigemptyset(&noSignalsBlocked)
        let reset: [Int32] = [SIGINT, SIGQUIT, SIGTSTP, SIGTTIN, SIGTTOU, SIGCHLD, SIGPIPE, SIGHUP, SIGTERM]
        let pid = forkpty(&master, nil, nil, &size)
        if pid == 0 {
            // The shell starts with every signal at its default, as in Terminal: a Forge started from a script in the
            // background inherits ⌃C ignored, and a shell can't trap a signal ignored on entry, so ⌃C did nothing.
            for sig in reset { signal(sig, SIG_DFL) }
            sigprocmask(SIG_SETMASK, &noSignalsBlocked, nil)
            if chdir(dir) != 0 { _exit(126) }
            execve(path, argv, envp)
            _exit(127)
        }
        guard pid > 0 else { return nil }
        let p = TerminalProcess(pid: pid, master: master)
        p.watch()
        return p
    }

    private func watch() {
        let r = DispatchSource.makeReadSource(fileDescriptor: master, queue: queue)
        r.setEventHandler { [weak self] in
            guard let self else { return }
            var buf = [UInt8](repeating: 0, count: 65536)
            let n = read(self.master, &buf, buf.count)
            if n > 0 {
                let bytes = Array(buf[0..<n])
                DispatchQueue.main.async { self.onOutput?(bytes) }
            } else if n == 0 || (errno != EAGAIN && errno != EINTR) {
                r.cancel()
            }
        }
        r.setCancelHandler { [master] in close(master) }
        reader = r
        r.resume()
        let e = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: queue)
        // Held strongly until the shell is reaped, so no shell is ever left a zombie.
        e.setEventHandler { self.reap() }
        exitWatch = e
        e.resume()
    }

    private func reap() {
        var status: Int32 = 0
        guard waitpid(pid, &status, WNOHANG) == pid else { return }
        exitWatch?.cancel()
        exitWatch = nil
        let first = lock.withLock { () -> Bool in
            defer { ended = true }
            return !ended
        }
        if first { DispatchQueue.main.async { self.onExit?() } }
    }

    var isRunning: Bool { lock.withLock { !ended } }

    func write(_ bytes: [UInt8]) {
        guard isRunning, !bytes.isEmpty else { return }
        queue.async { [master] in
            var off = 0
            while off < bytes.count {
                let n = bytes[off...].withUnsafeBufferPointer { Darwin.write(master, $0.baseAddress, $0.count) }
                if n <= 0 { break }
                off += n
            }
        }
    }

    func resize(cols: Int, rows: Int) {
        var size = winsize(ws_row: UInt16(clamping: rows), ws_col: UInt16(clamping: cols), ws_xpixel: 0, ws_ypixel: 0)
        _ = ioctl(master, TIOCSWINSZ, &size)
    }

    /// Hangs up on the shell and everything it started; kills what's left a second later.
    func terminate() {
        guard isRunning else { return }
        kill(-pid, SIGHUP)
        kill(pid, SIGHUP)
        queue.asyncAfter(deadline: .now() + 1) {
            guard self.isRunning else { return }
            kill(-self.pid, SIGKILL)
            kill(self.pid, SIGKILL)
            self.reap()
        }
    }
}
