import Foundation

/// GitHub's device sign-in through `gh`, shown inside Forge: Forge reads the one-time code `gh` prints,
/// shows it, and opens GitHub's device page. Used to sign in, and to ask GitHub for the one extra
/// permission registering a signing key needs. The person approves on github.com; no terminal.
enum GitHubSignIn {
    static let devicePage = "https://github.com/login/device"

    enum Purpose: Sendable, Equatable {
        case signIn
        /// The permission to add a signing key to the account (`admin:ssh_signing_key`).
        case signingKeyPermission

        var args: [String] {
            switch self {
            case .signIn: return ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key"]
            case .signingKeyPermission: return ["auth", "refresh", "--hostname", "github.com", "--scopes", "admin:ssh_signing_key"]
            }
        }
    }

    /// Runs the flow. `onCode` gets the one-time code as soon as `gh` prints it. Nil when GitHub approved; otherwise
    /// why not, in gh's own words. `gh` grants a permission to its active account, so for another account Forge
    /// switches to it for the flow and back afterwards. Cancelling the task stops `gh`.
    static func run(_ purpose: Purpose, codeWithin: TimeInterval = 30, onCode: @escaping @Sendable (String) -> Void) async -> String? {
        let path = await ToolPath.shared.value()
        let active = await GitHub.cliAccounts().first
        let switching = purpose == .signingKeyPermission && GitHub.account != nil && GitHub.account != active
        if switching, let a = GitHub.account {
            let r = await Tools.run("gh", ["auth", "switch", "--hostname", "github.com", "--user", a])
            guard r.ok else { return "GitHub CLI couldn't switch to @\(a): \(r.reason)" }
        }
        let stop = Tools.StopFlag()
        let why = await withTaskCancellationHandler {
            await withCheckedContinuation { cont in
                DispatchQueue.global().async {
                    cont.resume(returning: runSync(purpose, path: path, codeWithin: codeWithin, stop: stop, onCode: onCode))
                }
            }
        } onCancel: {
            stop.set()
        }
        if switching, let back = active {
            _ = await Tools.run("gh", ["auth", "switch", "--hostname", "github.com", "--user", back])
        }
        GitHub.forget()
        return why
    }

    private static func runSync(
        _ purpose: Purpose, path: String, codeWithin: TimeInterval, stop: Tools.StopFlag, onCode: @escaping @Sendable (String) -> Void
    ) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["gh"] + purpose.args
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = path
        // Forge opens the page itself, next to the code it shows.
        env["GH_BROWSER"] = "/usr/bin/true"
        env["BROWSER"] = "/usr/bin/true"
        p.environment = env
        let errPipe = Pipe()
        let inPipe = Pipe()
        p.standardError = errPipe
        p.standardOutput = errPipe
        p.standardInput = inPipe
        let seen = Seen()
        errPipe.fileHandleForReading.readabilityHandler = { h in
            let text = String(data: h.availableData, encoding: .utf8) ?? ""
            seen.add(text)
            if let code = code(in: text), seen.first(code) {
                onCode(code)
                inPipe.fileHandleForWriting.write(Data("\n".utf8))
            }
        }
        do { try p.run() } catch { return "GitHub CLI (gh) isn't installed on this Mac." }
        let started = Date()
        let deadline = started.addingTimeInterval(15 * 60)
        var why: String?
        while p.isRunning {
            if stop.isSet {
                why = "Cancelled."
            } else if !seen.hasCode && Date().timeIntervalSince(started) > codeWithin {
                why = "GitHub CLI didn't show a sign-in code within \(Int(codeWithin)) seconds."
            } else if Date() > deadline {
                why = "The code ran out before it was approved on GitHub."
            }
            if why != nil { break }
            usleep(200_000)
        }
        if p.isRunning {
            p.terminate()
            p.waitUntilExit()
        }
        errPipe.fileHandleForReading.readabilityHandler = nil
        let said = Tools.Result(status: p.terminationStatus, out: "", err: seen.text).reason
        if let why { return seen.text.isEmpty ? why : "\(why) It said: \(said)" }
        return p.terminationStatus == 0 ? nil : "GitHub CLI said: \(said)"
    }

    /// The `XXXX-XXXX` code in gh's "First copy your one-time code" line.
    static func code(in text: String) -> String? {
        guard text.contains("one-time code") else { return nil }
        let pattern = try? NSRegularExpression(pattern: "[A-Z0-9]{4}-[A-Z0-9]{4}")
        let range = NSRange(text.startIndex..., in: text)
        guard let m = pattern?.firstMatch(in: text, range: range), let r = Range(m.range, in: text) else { return nil }
        return String(text[r])
    }

    private final class Seen: @unchecked Sendable {
        private let lock = NSLock()
        private var done = false
        private var all = ""
        func first(_: String) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            if done { return false }
            done = true
            return true
        }
        var hasCode: Bool { lock.withLock { done } }
        func add(_ s: String) { lock.withLock { all += s } }
        /// Everything gh printed, without the code lines.
        var text: String {
            lock.withLock {
                all.split(separator: "\n").filter { !$0.contains("one-time code") && !$0.contains("Open this URL") }.joined(separator: "\n")
            }
        }
    }
}
