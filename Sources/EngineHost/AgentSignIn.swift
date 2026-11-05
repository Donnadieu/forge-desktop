import AppKit
import Darwin
import Foundation

/// Signs an agent back in without a terminal: runs the agent's own sign-in (`claude setup-token`,
/// `codex login`), which opens the browser itself. Forge shows the guide, offers the link again, and
/// passes along the code when the page asks the person to paste one.
///
/// Claude Code gets a long-lived token (about a year) that Forge keeps in the Keychain and hands to
/// its agents. A browser login has a time limit that renewing doesn't move ("OAuth session expired"),
/// and Claude Code itself says to use `setup-token` for unattended work.
@MainActor
final class AgentSignIn: ObservableObject {
    enum Stage: Equatable {
        case idle
        /// Waiting for the person to finish in the browser.
        case waiting
        case done
        case failed(String)
    }

    @Published private(set) var stage: Stage = .idle
    @Published private(set) var link: URL?
    /// The sign-in takes a pasted code if the browser can't hand it back by itself.
    @Published private(set) var acceptsCode = false
    private var process: Process?
    private var input: FileHandle?
    private var worker: SetupChoices.Worker?
    /// The account signing in: its login folder and the Keychain item its sign-in goes to.
    private var account: AIAccount?

    static func command(for worker: SetupChoices.Worker) -> [String]? {
        switch worker {
        case .claude: return ["claude", "setup-token"]
        case .codex: return ["codex", "login"]
        case .kimi, .apiKey, .codexKey, .openrouter: return nil
        }
    }

    /// Reads what the sign-in prints: the link to open, and whether it wants a code pasted.
    nonisolated static func scan(_ text: String) -> (link: URL?, wantsCode: Bool) {
        let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        let range = NSRange(text.startIndex..., in: text)
        let url = detector?.matches(in: text, range: range).compactMap(\.url).first { $0.scheme == "https" }
        let wantsCode =
            text.range(of: "paste code", options: .caseInsensitive) != nil
            || text.range(of: "paste the code", options: .caseInsensitive) != nil
        return (url, wantsCode)
    }

    /// Claude Code's sign-in draws a terminal screen: it runs in one (wide, so nothing wraps).
    nonisolated static func needsTerminal(_ worker: SetupChoices.Worker) -> Bool { worker == .claude }

    /// Removes a terminal's colour and cursor codes, keeping the text. A cursor move becomes a line
    /// break: Claude Code draws its screen with moves instead of newlines, and dropping them glued the
    /// next line's first word onto the token (0.2.7 kept "<token>Store").
    nonisolated static func plain(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{1B}\\][^\u{07}\u{1B}]*(\u{07}|\u{1B}\\\\)", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\u{1B}\\[[0-9;?]*[ -/]*[A-HJKSTf]", with: "\n", options: .regularExpression)
            .replacingOccurrences(of: "\u{1B}\\[[0-9;?]*[ -/]*[@-~]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\r", with: "")
    }

    /// The long-lived token `claude setup-token` prints once the person approves, if it's all there:
    /// only a token followed by a space or line break counts, so half of one read mid-print never does.
    nonisolated static func token(in text: String) -> String? {
        let t = plain(text)
        guard let r = t.range(of: "sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,}(?=\\s)", options: .regularExpression) else { return nil }
        return String(t[r])
    }

    /// Repairs a token 0.2.7 kept with the next line's first word stuck on ("…Store"), so that sign-in
    /// works without approving again.
    nonisolated static func repaired(_ token: String) -> String {
        token.hasPrefix("sk-ant-oat") && token.hasSuffix("Store") ? String(token.dropLast(5)) : token
    }

    /// True when a failed check reads like a lapsed or missing sign-in rather than a broken install.
    nonisolated static func looksSignedOut(_ message: String) -> Bool {
        let m = message.lowercased()
        return ["authenticate", "oauth", "log in", "login", "sign in", "expired", "401", "unauthorized", "not logged"].contains { m.contains($0) }
    }

    /// Signs one account in, inside its own login folder (CLAUDE_CONFIG_DIR, CODEX_HOME), so the person's own
    /// Claude Code and Codex logins and every other account stay as they are. Call `preparedForSignIn()` first.
    func start(_ account: AIAccount) async {
        cancel()
        let worker = account.worker
        guard let cmd = Self.command(for: worker) else { return }
        self.worker = worker
        self.account = account
        stage = .waiting
        link = nil
        acceptsCode = false
        let path = await ToolPath.shared.value()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = cmd
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = path
        // A token already in the environment would stand in for the new sign-in.
        env.removeValue(forKey: "CLAUDE_CODE_OAUTH_TOKEN")
        if let folder = account.folderURL {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            env[worker == .codex ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] = folder.path
        }
        let reader: FileHandle
        if Self.needsTerminal(worker), let tty = Self.openTerminal() {
            env["TERM"] = "xterm-256color"
            p.standardInput = tty.child
            p.standardOutput = tty.child
            p.standardError = tty.child
            reader = tty.parent
            input = tty.parent
        } else {
            let out = Pipe()
            let inp = Pipe()
            p.standardOutput = out
            p.standardError = out
            p.standardInput = inp
            reader = out.fileHandleForReading
            input = inp.fileHandleForWriting
        }
        p.environment = env
        var seen = ""
        reader.readabilityHandler = { [weak self] h in
            let chunk = String(data: h.availableData, encoding: .utf8) ?? ""
            guard !chunk.isEmpty else { return }
            Task { @MainActor in
                guard let self else { return }
                seen += chunk
                self.read(seen)
            }
        }
        p.terminationHandler = { [weak self] proc in
            let status = proc.terminationStatus
            Task { @MainActor in
                guard let self, self.process === proc else { return }
                reader.readabilityHandler = nil
                self.process = nil
                // Already settled (signed in, cancelled, or a problem said): keep that answer.
                if self.stage != .waiting { return }
                if status == 0, !Self.needsTerminal(worker) {
                    self.stage = .done
                } else {
                    self.stage = .failed("The sign-in didn't finish. Try again.")
                }
            }
        }
        do {
            try p.run()
            process = p
            if Self.needsTerminal(worker) { try? (p.standardInput as? FileHandle)?.close() }
        } catch {
            stage = .failed("\(cmd[0]) isn't installed on this Mac.")
        }
    }

    /// Reads what the sign-in printed so far: the link, a code prompt, and Claude Code's token.
    private func read(_ seen: String) {
        let found = Self.scan(Self.plain(seen))
        // A terminal may print the link only inside a hyperlink code: look in the raw text too.
        if link == nil, let u = found.link ?? Self.scan(seen).link { link = u }
        if found.wantsCode { acceptsCode = true }
        if worker == .claude, stage == .waiting, let token = Self.token(in: seen) {
            let item = account?.secretItem ?? Keychain.Item.claudeToken.rawValue
            stage = Keychain.set(token, named: item) ? .done : .failed("Forge couldn't keep the sign-in in your Keychain.")
            stop(process)
        }
    }

    /// Ends the sign-in program; a terminal program may ignore the polite signal, so it's forced after 2 s.
    private func stop(_ p: Process?) {
        guard let p, p.isRunning else { return }
        p.terminate()
        let pid = p.processIdentifier
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { if p.isRunning { kill(pid, SIGKILL) } }
    }

    /// A terminal pair 400 columns wide, so a long link or token prints on one line.
    private static func openTerminal() -> (parent: FileHandle, child: FileHandle)? {
        var parent: Int32 = -1
        var child: Int32 = -1
        var size = winsize(ws_row: 50, ws_col: 400, ws_xpixel: 0, ws_ypixel: 0)
        guard openpty(&parent, &child, nil, nil, &size) == 0 else { return nil }
        return (FileHandle(fileDescriptor: parent, closeOnDealloc: true), FileHandle(fileDescriptor: child, closeOnDealloc: true))
    }

    /// Sends the code the sign-in page showed.
    func send(code: String) {
        let c = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !c.isEmpty else { return }
        // A terminal takes Return as "\r"; a pipe takes a newline.
        input?.write(Data((c + (worker.map(Self.needsTerminal) == true ? "\r" : "\n")).utf8))
        stage = .waiting
    }

    func openLink() {
        if let link { NSWorkspace.shared.open(link) }
    }

    /// Render mode: show the guide as it looks while waiting, without running anything.
    func preview(link: URL?, code: Bool = true) {
        stage = .waiting
        self.link = link
        acceptsCode = code
    }

    func cancel() {
        stop(process)
        process = nil
        stage = .idle
    }
}
