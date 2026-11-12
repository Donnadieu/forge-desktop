import Foundation

/// The PATH agents need. An app opened from the Dock gets a bare PATH (/usr/bin:/bin...), so the person's own
/// tools (claude, codex, gh, git, gpg) would be missing. This asks their login shell once, and adds the usual places.
actor ToolPath {
    static let shared = ToolPath()
    private var cached: String?

    func value() async -> String {
        if let c = cached { return c }
        let v = ToolPath.compose(login: ToolPath.loginShellPath(), home: FileManager.default.homeDirectoryForCurrentUser.path)
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

extension ToolPath {
    /// The login shell's PATH, the usual places, then version managers' shims when they're installed: a login shell
    /// that isn't interactive never runs the `mise activate` in .zshrc, so `node` and `npx` were missing and the
    /// person's MCP servers started with npx failed in every agent (Omar's Andela chats, Nov 12).
    nonisolated static func compose(
        login: String, home: String, exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> String {
        let usual = [
            "\(home)/.local/bin", "\(home)/.claude/local", "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin",
            "/usr/bin", "/bin", "/usr/sbin", "/sbin",
        ]
        let shims = ["\(home)/.local/share/mise/shims", "\(home)/.asdf/shims"].filter(exists)
        var parts = login.split(separator: ":").map(String.init)
        for u in usual + shims where !parts.contains(u) { parts.append(u) }
        return parts.filter { !$0.isEmpty }.joined(separator: ":")
    }
}
