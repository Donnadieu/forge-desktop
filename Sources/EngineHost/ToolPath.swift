import Foundation

/// The PATH agents need. An app opened from the Dock gets a bare PATH (/usr/bin:/bin...), so the person's own
/// tools (claude, codex, gh, git, gpg) would be missing. This asks their login shell once, and adds the usual places.
actor ToolPath {
    static let shared = ToolPath()
    private var cached: String?

    func value() async -> String {
        if let c = cached { return c }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let usual = [
            "\(home)/.local/bin", "\(home)/.claude/local", "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin",
            "/usr/bin", "/bin", "/usr/sbin", "/sbin",
        ]
        var parts = ToolPath.loginShellPath().split(separator: ":").map(String.init)
        for u in usual where !parts.contains(u) { parts.append(u) }
        let v = parts.filter { !$0.isEmpty }.joined(separator: ":")
        cached = v
        return v
    }

    /// `$SHELL -l -c 'printf %s "$PATH"'`, with a 5 second limit. Empty if the shell can't tell.
    static func loginShellPath() -> String {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: shell)
        p.arguments = ["-l", "-c", "printf %s \"$PATH\""]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return "" }
        let deadline = Date().addingTimeInterval(5)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        if p.isRunning {
            p.terminate()
            return ""
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8) ?? ""
    }
}
