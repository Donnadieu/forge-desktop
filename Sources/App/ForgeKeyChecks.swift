import Foundation
import Security

/// Setup 3's "Me, with a key Forge makes": a person saw "Working…", nothing else, then a failure with no reason
/// (Nov 27 2026). Every step now has a time limit, says what went wrong in the tools' own words, and offers the one
/// thing that fixes it. GitHub's answers below are what GitHub CLI 2.97 printed against a stand-in GitHub
/// (recorded Nov 27 2026); the signing checks run the real git, ssh-keygen and ssh-agent in a scratch folder.
@MainActor
extension Checks {
    static func forgeKeyChecks(_ check: (String, Bool) -> Void) {
        forgeKeyAnswerChecks(check)
        forgeKeyFlowChecks(check)
        forgeKeySigningChecks(check)
        toolTimeLimitChecks(check)
    }

    /// What `gh api user/ssh_signing_keys` printed for each answer GitHub can give.
    enum RecordedGH {
        static let pub = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStandIn"
        static let scopeHint =
            "gh: Not Found (HTTP 404)\ngh: This API operation needs the \"admin:ssh_signing_key\" scope. To request it, run:  "
            + "gh auth refresh -h github.com -s admin:ssh_signing_key\n"
        static let notFound = #"{"message": "Not Found", "documentation_url": "https://docs.github.com/rest", "status": "404"}"#
        static let noScope = Tools.Result(status: 1, out: notFound, err: scopeHint)
        static let listed = Tools.Result(status: 0, out: pub + "\n", err: "")
        static let listedOther = Tools.Result(status: 0, out: "ssh-ed25519 AAAAOther\n", err: "")
        /// The list with the key the check just made in it (filled in when it's asked for).
        static let ours = Tools.Result(status: 0, out: "<ours>", err: "")
        static let added = Tools.Result(status: 0, out: #"{"id": 7, "title": "Commit signing"}"#, err: "")
        static let fineGrained = Tools.Result(
            status: 1,
            out: #"{"message": "Resource not accessible by personal access token", "status": "403"}"#,
            err: "gh: Resource not accessible by personal access token (HTTP 403)\n")
        static let inUse = Tools.Result(
            status: 1,
            out: #"{"message": "Validation Failed", "errors": [{"resource": "SshSigningKey", "code": "custom", "field": "key", "#
                + #""message": "key is already in use"}], "status": "422"}"#,
            err: "gh: Validation Failed (HTTP 422)\n")
        static let slow = Tools.Result(status: 124, out: "", err: "")
        static let missing = Tools.Result(status: 127, out: "", err: "gh isn't installed")
    }

    static func forgeKeyAnswerChecks(_ check: (String, Bool) -> Void) {
        typealias K = ForgeSigningKey
        let pub = RecordedGH.pub
        check("a listed key is on GitHub", K.keyState(RecordedGH.listed, publicKey: pub) == .onGitHub)
        check("another key listed means ours isn't there yet", K.keyState(RecordedGH.listedOther, publicKey: pub) == .notOnGitHub)
        check("a sign-in that can't read signing keys needs the permission", K.keyState(RecordedGH.noScope, publicKey: pub) == .needsPermission)
        check("a slow GitHub is a problem with a reason, not 'not there'", K.keyState(RecordedGH.slow, publicKey: pub).isFailure)
        check("added is added", K.registration(RecordedGH.added) == .done)
        check("adding without the permission asks for it", K.registration(RecordedGH.noScope) == .needsPermission)
        check("a fine-grained token without the permission asks for it", K.registration(RecordedGH.fineGrained) == .needsPermission)
        check("a key GitHub already has is told apart from a failure", K.registration(RecordedGH.inUse) == .inUse)
        if case .failed(let why) = K.registration(RecordedGH.slow) {
            check("a GitHub that doesn't answer says so", why.contains("didn't answer"))
        } else {
            check("a GitHub that doesn't answer says so", false)
        }
        if case .failed(let why) = K.registration(RecordedGH.missing) {
            check("a Mac without GitHub CLI says so", why.contains("GitHub CLI"))
        } else {
            check("a Mac without GitHub CLI says so", false)
        }
        check(
            "the permission comes from GitHub CLI for an account it signed in",
            SigningPermission.route(account: "marin", cliAccounts: ["marin", "work"]) == .cli("marin"))
        check(
            "and from Forge's own sign-in for an account added in Forge, never from another account's",
            SigningPermission.route(account: "marin", cliAccounts: ["work"]) == .forge(GitHubAccountRecord.item("marin")))
        check("the permission Forge asks for adds signing keys", SigningPermission.scopes.contains("admin:ssh_signing_key"))
        check(
            "the key's name on GitHub is the one the screen promises",
            GitHubScreen.changeNote.contains("\"\(ForgeSigningKey.title)\""))
        let fixes: [SigningProblem.Fix: String] = [
            .permission: "Reconnect GitHub with signing-key permission", .newKey: "Make a new key", .tryAgain: "Try again",
        ]
        check("each problem offers its own fix", fixes.allSatisfy { SigningProblem(text: "x", fix: $0.key).fixTitle == $0.value })
        check("and a way on without signing", SigningProblem.unsignedTitle == "Continue with unsigned commits for now")
    }

    /// The whole step against recorded GitHub answers, a scratch key and a stand-in for the Keychain.
    static func forgeKeyFlowChecks(_ check: (String, Bool) -> Void) {
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("forge-key-flow-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: scratch) }

        // A Keychain that refuses: the reason is macOS's own words.
        let refused = FakeGitHub.place(in: scratch.appendingPathComponent("refused"), answers: [])
        refused.place.savePrivate = { _ in errSecInteractionNotAllowed }
        let keychain = runFlow(refused, register: false)
        check(
            "a Keychain that won't keep the key says why",
            keychain?.problem?.text.contains("Keychain") == true && keychain?.problem?.fix == .tryAgain)

        // No permission to read or add signing keys: ask first, then get the permission, then add the key.
        let fresh = FakeGitHub.place(
            in: scratch.appendingPathComponent("fresh"), answers: [RecordedGH.noScope, RecordedGH.noScope, RecordedGH.noScope, RecordedGH.added])
        check("a key GitHub doesn't have yet is asked about first", runFlow(fresh, register: false) == .ask)
        let granted = ForgeSigningKey.SecretBox()
        let added = runFlow(fresh, register: true) {
            granted.value = "asked"
            return nil
        }
        check("without the permission, Forge asks GitHub for it", granted.value == "asked")
        check(
            "then adds the key and stops at the agent, with the agent's reason",
            added?.problem?.text.contains("SSH agent") == true && fresh.calls().last?.contains("POST") == true)

        // The person turns the permission down: say so, and offer the reconnect.
        let denied = FakeGitHub.place(in: scratch.appendingPathComponent("denied"), answers: [RecordedGH.noScope, RecordedGH.noScope])
        let no = runFlow(denied, register: true) { "The sign-in was turned down on GitHub." }
        check(
            "a permission turned down offers the reconnect",
            no?.problem == SigningProblem(text: "The sign-in was turned down on GitHub.", fix: .permission))

        // Approved as another account: GitHub still says no; never fall through as if it worked.
        let wrong = FakeGitHub.place(
            in: scratch.appendingPathComponent("wrong"), answers: [RecordedGH.noScope, RecordedGH.noScope, RecordedGH.noScope])
        let still = runFlow(wrong, register: true) { nil }
        check("a permission that didn't take is a problem, not a silent success", still?.problem?.fix == .permission)

        // GitHub already has the key (an earlier try added it): carry on.
        let again = FakeGitHub.place(
            in: scratch.appendingPathComponent("again"), answers: [RecordedGH.listedOther, RecordedGH.inUse, RecordedGH.ours])
        let kept = runFlow(again, register: true)
        check("a key GitHub already has on this account is used as it is", kept?.problem?.text.contains("SSH agent") == true)
        // On another account: offer a new key.
        let other = FakeGitHub.place(
            in: scratch.appendingPathComponent("other"), answers: [RecordedGH.listedOther, RecordedGH.inUse, RecordedGH.listedOther])
        check("a key that's on another GitHub account offers a new key", runFlow(other, register: true)?.problem?.fix == .newKey)

        // GitHub doesn't answer: a problem within the time limit, with Try again.
        let slow = FakeGitHub.place(in: scratch.appendingPathComponent("slow"), answers: [RecordedGH.slow])
        let late = runFlow(slow, register: false)
        check("a GitHub that doesn't answer stops with a reason", late?.problem?.fix == .tryAgain && late?.problem?.text.contains("answer") == true)
    }

    static func runFlow(_ fake: FakeGitHub, register: Bool, grant: @escaping @Sendable () async -> String? = { nil }) -> ForgeKeyFlow.Outcome? {
        var unloadedAgent = fake.place
        // No agent at all: the step must stop there with the agent's words.
        unloadedAgent.env["SSH_AUTH_SOCK"] = fake.folder.appendingPathComponent("no-agent.sock").path
        let place = unloadedAgent
        return ArchiveCheck.wait(60) {
            await ForgeKeyFlow.run(
                login: "marin", name: "Marin", email: "7+marin@users.noreply.github.com", register: register, place: place, grant: grant)
        }
    }

    /// Recorded answers in order, one per GitHub call, and the calls made.
    final class FakeGitHub: @unchecked Sendable {
        let folder: URL
        var place: ForgeSigningKey.Place
        private var answers: [Tools.Result]
        private var made: [String] = []
        private let lock = NSLock()

        private init(folder: URL, answers: [Tools.Result]) {
            self.folder = folder
            self.answers = answers
            self.place = ForgeSigningKey.Place.scratch(in: folder)
        }

        static func place(in folder: URL, answers: [Tools.Result]) -> FakeGitHub {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let f = FakeGitHub(folder: folder, answers: answers)
            f.place.gh = { [f] args, _ in f.next(args) }
            return f
        }

        func next(_ args: [String]) -> Tools.Result {
            lock.lock()
            defer { lock.unlock() }
            made.append(args.joined(separator: " "))
            guard !answers.isEmpty else { return Tools.Result(status: 1, out: "", err: "no recorded answer") }
            let a = answers.removeFirst()
            return a.out == "<ours>" ? Tools.Result(status: 0, out: (ForgeSigningKey.publicKey(place) ?? "") + "\n", err: "") : a
        }

        func calls() -> [String] {
            lock.lock()
            defer { lock.unlock() }
            return made
        }
    }

    /// The test commit, with the real tools: a scratch ssh-agent, and a person whose global git config signs through
    /// another program (1Password's op-ssh-sign is the usual one) and runs a hook on every commit.
    static func forgeKeySigningChecks(_ check: (String, Bool) -> Void) {
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("forge-key-sign-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: scratch) }
        // A Unix socket's path is limited to 104 bytes, and the temporary folder's is long.
        let sock = "/tmp/forge-agent-\(UUID().uuidString.prefix(8)).sock"
        defer { try? FileManager.default.removeItem(atPath: sock) }
        let started = ArchiveCheck.wait(20) { await Tools.run("ssh-agent", ["-s", "-a", sock], timeout: 10) }
        let pid = started?.out.components(separatedBy: "SSH_AGENT_PID=").dropFirst().first.flatMap { Int32($0.prefix { $0.isNumber }) }
        guard let pid, ArchiveCheck.until(5, { FileManager.default.fileExists(atPath: sock) }) else {
            check("a scratch ssh-agent starts", false)
            return
        }
        defer { kill(pid, SIGTERM) }

        // The person's own global git config: another signing program, and a hook that refuses every commit.
        let other = scratch.appendingPathComponent("op-ssh-sign")
        try? "#!/bin/sh\necho 'error: 1Password: no matching key' >&2\nexit 1\n".write(to: other, atomically: true, encoding: .utf8)
        let hooks = scratch.appendingPathComponent("hooks")
        try? FileManager.default.createDirectory(at: hooks, withIntermediateDirectories: true)
        try? "#!/bin/sh\necho 'the person's own pre-commit hook' >&2\nexit 1\n".write(
            to: hooks.appendingPathComponent("pre-commit"), atomically: true, encoding: .utf8)
        for f in [other, hooks.appendingPathComponent("pre-commit")] { chmod(f.path, 0o755) }
        let global = scratch.appendingPathComponent("person.gitconfig")
        try? "[gpg \"ssh\"]\n\tprogram = \(other.path)\n[core]\n\thooksPath = \(hooks.path)\n".write(to: global, atomically: true, encoding: .utf8)

        var place = ForgeSigningKey.Place.scratch(in: scratch)
        place.env = ["SSH_AUTH_SOCK": sock, "GIT_CONFIG_GLOBAL": global.path]
        let p = place
        let made = ArchiveCheck.wait(30) { await ForgeSigningKey.make(comment: "check", in: p) }
        check("Forge makes a key", made == .some(nil) && ForgeSigningKey.exists(p))
        let loaded = ArchiveCheck.wait(30) { await ForgeSigningKey.loadIntoAgent(p) }
        check("the agent takes it", loaded == .some(nil))
        let signs = ArchiveCheck.wait(60) {
            await GitHub.signCheck(name: "Marin", email: "7+marin@users.noreply.github.com", signing: .forgeKey, key: p.publicKeyURL.path, env: p.env)
        }
        check("the test commit signs with Forge's key whatever the person's global git config signs with", signs == .some(nil))

        // A key the agent doesn't hold: the reason is ssh-keygen's, not "didn't come out signed".
        var empty = p
        let other2 = scratch.appendingPathComponent("absent.pub")
        try? "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGJ2Y2Y2Y2Y2Y2Y2Y2Y2Y2Y2Y2Y2Y2Y2Y2Y2Y2Y2Y2Y2 absent\n".write(
            to: other2, atomically: true, encoding: .utf8)
        empty.publicKeyURL = other2
        let e = empty
        let why = ArchiveCheck.wait(60) {
            await GitHub.signCheck(name: "Marin", email: "m@example.com", signing: .forgeKey, key: e.publicKeyURL.path, env: e.env)
        }
        check("a key that can't sign says git's own reason", (why ?? nil).map { !$0.isEmpty && !$0.contains("didn't come out signed") } == true)

        // No agent at all.
        var noAgent = p
        noAgent.env["SSH_AUTH_SOCK"] = scratch.appendingPathComponent("gone.sock").path
        let n = noAgent
        let agentWhy = ArchiveCheck.wait(30) { await ForgeSigningKey.loadIntoAgent(n) }
        check("no SSH agent says so", (agentWhy ?? nil)?.contains("SSH agent") == true)
    }

    /// A tool never holds the screen past its time limit: not when it ignores the stop, not when something it started
    /// keeps its output open.
    static func toolTimeLimitChecks(_ check: (String, Bool) -> Void) {
        let start = Date()
        let held = ArchiveCheck.wait(30) { await Tools.run("/bin/sh", ["-c", "sleep 20 & echo started"], timeout: 2) }
        let heldTime = Date().timeIntervalSince(start)
        check("a tool whose child keeps its output open returns soon after it ends", held != nil && heldTime < 6)
        check("and keeps what it printed", held?.out.contains("started") == true)
        let stubborn = Date()
        let r = ArchiveCheck.wait(30) { await Tools.run("/bin/sh", ["-c", "trap '' TERM; sleep 20"], timeout: 1) }
        check("a tool that ignores the stop is stopped anyway", r != nil && Date().timeIntervalSince(stubborn) < 6)
        check("and reads as timed out", r?.timedOut == true)
    }
}

extension ForgeSigningKey.KeyState {
    var isFailure: Bool {
        if case .failed = self { return true }
        return false
    }
}

extension ForgeKeyFlow.Outcome {
    var problem: SigningProblem? {
        if case .problem(let p) = self { return p }
        return nil
    }
}
