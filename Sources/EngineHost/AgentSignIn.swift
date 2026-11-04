import AppKit
import Foundation

/// Signs an agent back in without a terminal: runs the agent's own sign-in (`claude auth login`,
/// `codex login`), which opens the browser itself. Forge shows the guide, offers the link again, and
/// passes along the code when the page asks the person to paste one.
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

    static func command(for worker: SetupChoices.Worker) -> [String]? {
        switch worker {
        case .claude: return ["claude", "auth", "login", "--claudeai"]
        case .codex: return ["codex", "login"]
        case .kimi, .apiKey, .codexKey: return nil
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

    /// True when a failed check reads like a lapsed or missing sign-in rather than a broken install.
    nonisolated static func looksSignedOut(_ message: String) -> Bool {
        let m = message.lowercased()
        return ["authenticate", "oauth", "log in", "login", "sign in", "expired", "401", "unauthorized", "not logged"].contains { m.contains($0) }
    }

    func start(_ worker: SetupChoices.Worker) async {
        cancel()
        guard let cmd = Self.command(for: worker) else { return }
        stage = .waiting
        link = nil
        acceptsCode = false
        let path = await ToolPath.shared.value()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = cmd
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = path
        p.environment = env
        let out = Pipe()
        let inp = Pipe()
        p.standardOutput = out
        p.standardError = out
        p.standardInput = inp
        var seen = ""
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            let chunk = String(data: h.availableData, encoding: .utf8) ?? ""
            guard !chunk.isEmpty else { return }
            Task { @MainActor in
                guard let self else { return }
                seen += chunk
                let found = Self.scan(seen)
                if self.link == nil, let u = found.link { self.link = u }
                if found.wantsCode { self.acceptsCode = true }
            }
        }
        p.terminationHandler = { [weak self] proc in
            let status = proc.terminationStatus
            Task { @MainActor in
                guard let self, self.process === proc else { return }
                out.fileHandleForReading.readabilityHandler = nil
                self.process = nil
                if status == 0 {
                    self.stage = .done
                } else if self.stage != .idle {
                    self.stage = .failed("The sign-in didn't finish. Try again.")
                }
            }
        }
        do {
            try p.run()
            process = p
            input = inp.fileHandleForWriting
        } catch {
            stage = .failed("\(cmd[0]) isn't installed on this Mac.")
        }
    }

    /// Sends the code the sign-in page showed.
    func send(code: String) {
        let c = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !c.isEmpty else { return }
        input?.write(Data((c + "\n").utf8))
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
        if let p = process, p.isRunning { p.terminate() }
        process = nil
        stage = .idle
    }
}
