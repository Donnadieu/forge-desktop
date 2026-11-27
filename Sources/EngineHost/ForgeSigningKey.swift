import Foundation
import Security

/// The signing key Forge makes (setup screen 3, first choice): an SSH key whose private half lives only in
/// the Keychain. Before the engine starts, Forge hands it to the Mac's ssh-agent; git signs through the
/// agent with only the public half on disk. Registering it on GitHub changes the person's account, so the
/// app asks first. Every step answers with the reason it failed, in the tools' own words.
enum ForgeSigningKey {
    /// Where the key lives and how Forge reaches GitHub; checks swap in a scratch folder and recorded answers.
    struct Place: Sendable {
        var publicKeyURL: URL
        var loadPrivate: @Sendable () -> String?
        var savePrivate: @Sendable (String) -> OSStatus
        /// Added to every tool's environment (checks: a scratch ssh-agent, a stand-in for the person's git config).
        var env: [String: String] = [:]
        var gh: @Sendable ([String], TimeInterval) async -> Tools.Result

        static var person: Place {
            Place(
                publicKeyURL: Paths.home.appendingPathComponent("signing/forge_signing.pub"),
                loadPrivate: { Keychain.get(.signingKey) },
                savePrivate: { Keychain.save($0, named: Keychain.Item.signingKey.rawValue) },
                gh: { args, timeout in await GitHub.gh(args, timeout: timeout) })
        }

        /// A key kept in memory and a public half in `folder`; GitHub calls fail until a check sets `gh`.
        static func scratch(in folder: URL) -> Place {
            let box = SecretBox()
            return Place(
                publicKeyURL: folder.appendingPathComponent("forge_signing.pub"), loadPrivate: { box.value },
                savePrivate: {
                    box.value = $0
                    return errSecSuccess
                }, gh: { _, _ in Tools.Result(status: 1, out: "", err: "no GitHub in checks") })
        }
    }

    final class SecretBox: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: String?
        var value: String? {
            get { lock.withLock { stored } }
            set { lock.withLock { stored = newValue } }
        }
    }

    static var publicKeyURL: URL { Place.person.publicKeyURL }

    static func exists(_ p: Place = .person) -> Bool { FileManager.default.fileExists(atPath: p.publicKeyURL.path) && p.loadPrivate() != nil }

    static func publicKey(_ p: Place = .person) -> String? {
        (try? String(contentsOf: p.publicKeyURL, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Makes a new ed25519 key: private half into the Keychain, public half next to Forge's settings.
    /// Nil when it's made; otherwise why not.
    static func make(comment: String, in p: Place = .person) async -> String? {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("forge-key-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: tmp) }
        let file = tmp.appendingPathComponent("k")
        let r = await Tools.run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", file.path], env: p.env, timeout: 20)
        if r.status == 127 { return "ssh-keygen isn't on this Mac's PATH, so Forge can't make a key." }
        if r.timedOut { return "Making the key took longer than 20 seconds (ssh-keygen didn't finish)." }
        guard r.ok, let priv = try? String(contentsOf: file, encoding: .utf8),
            let pub = try? String(contentsOf: file.appendingPathExtension("pub"), encoding: .utf8)
        else { return "ssh-keygen didn't make the key: \(r.reason)" }
        let saved = p.savePrivate(priv)
        guard saved == errSecSuccess else {
            let words = (SecCopyErrorMessageString(saved, nil) as String?) ?? "error \(saved)"
            return "macOS didn't let Forge keep the key in your Keychain: \(words)"
        }
        do {
            try FileManager.default.createDirectory(at: p.publicKeyURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try pub.write(to: p.publicKeyURL, atomically: true, encoding: .utf8)
        } catch { return "Forge couldn't save the key's public half: \(error.localizedDescription)" }
        return nil
    }

    /// Forgets the key (the "Make a new key" fix); the one on GitHub stays until the person removes it there.
    static func forget(_ p: Place = .person) {
        try? FileManager.default.removeItem(at: p.publicKeyURL)
    }

    /// Hands the private half to the Mac's ssh-agent (read from stdin; never written to disk). Nil when it took it.
    static func loadIntoAgent(_ p: Place = .person) async -> String? {
        guard let priv = p.loadPrivate() else { return "Forge's key isn't in your Keychain any more. Make a new key." }
        let sock = p.env["SSH_AUTH_SOCK"] ?? ProcessInfo.processInfo.environment["SSH_AUTH_SOCK"] ?? ""
        if sock.isEmpty { return "Your Mac's SSH agent isn't running for Forge (SSH_AUTH_SOCK isn't set), so git can't sign with the key." }
        let r = await Tools.run("ssh-add", ["-q", "-"], input: priv, env: p.env, timeout: 15)
        if r.ok { return nil }
        if r.timedOut { return "Your Mac's SSH agent didn't answer within 15 seconds." }
        return "Your Mac's SSH agent didn't take the key: \(r.reason) If another app (1Password, for one) runs your SSH agent, "
            + "it may not take keys from other apps."
    }

    enum KeyState: Equatable {
        case onGitHub, notOnGitHub, needsPermission
        case failed(String)
    }

    /// GitHub's list of the person's signing keys (`gh api user/ssh_signing_keys --jq '.[].key'`), read.
    static func keyState(_ r: Tools.Result, publicKey pub: String) -> KeyState {
        if r.ok {
            let body = pub.split(separator: " ").prefix(2).joined(separator: " ")
            return r.out.contains(body) ? .onGitHub : .notOnGitHub
        }
        if let why = toolProblem(r) { return .failed(why) }
        if needsPermission(r) { return .needsPermission }
        return .failed(r.reason)
    }

    static func state(_ p: Place = .person) async -> KeyState {
        guard let pub = publicKey(p) else { return .notOnGitHub }
        return keyState(await p.gh(["api", "user/ssh_signing_keys", "--jq", ".[].key"], 20), publicKey: pub)
    }

    enum Registration: Equatable {
        case done
        case needsPermission
        /// GitHub already has this key, on this account or another.
        case inUse
        case failed(String)
    }

    /// GitHub's answer to adding the key, read.
    static func registration(_ r: Tools.Result) -> Registration {
        if r.ok { return .done }
        if let why = toolProblem(r) { return .failed(why) }
        if (r.out + r.err).contains("already in use") { return .inUse }
        if needsPermission(r) { return .needsPermission }
        return .failed(r.reason)
    }

    /// GitHub hides signing keys from a sign-in without the permission: 404 with gh's hint for an OAuth sign-in,
    /// 403 for a fine-grained token.
    static func needsPermission(_ r: Tools.Result) -> Bool {
        r.err.contains("ssh_signing_key") || r.err.contains("HTTP 404") || r.err.contains("HTTP 403")
    }

    /// A GitHub CLI that isn't there or didn't answer in time.
    static func toolProblem(_ r: Tools.Result) -> String? {
        if r.status == 127 { return "GitHub CLI (gh) isn't installed on this Mac." }
        if r.timedOut { return "GitHub didn't answer within 20 seconds. Check your connection." }
        return nil
    }

    /// The key's name on GitHub, which anyone can read (`/users/<login>/ssh_signing_keys`): plain, never the app's.
    static let title = "Commit signing"

    /// Adds the public half to the person's GitHub as a signing key. Only after they said yes in the app.
    static func register(title: String, in p: Place = .person) async -> Registration {
        guard let pub = publicKey(p) else { return .failed("there's no key yet") }
        return registration(await p.gh(["api", "-X", "POST", "user/ssh_signing_keys", "-f", "title=\(title)", "-f", "key=\(pub)"], 20))
    }
}

/// Why the Forge-key step stopped, and the one thing that fixes it.
struct SigningProblem: Equatable, Sendable {
    enum Fix: Equatable, Hashable, Sendable {
        /// Sign GitHub in again with the permission to add signing keys.
        case permission
        /// Forget this key and make another.
        case newKey
        case tryAgain
    }
    let text: String
    let fix: Fix

    var fixTitle: String {
        switch fix {
        case .permission: return "Reconnect GitHub with signing-key permission"
        case .newKey: return "Make a new key"
        case .tryAgain: return "Try again"
        }
    }

    /// Always offered beside the fix: carry on now, sign later from Settings.
    static let unsignedTitle = "Continue with unsigned commits for now"
}

/// The Forge-key step from the click to a signed test commit. Never hangs: every tool has a time limit, and
/// the permission wait shows its code.
enum ForgeKeyFlow {
    enum Outcome: Equatable {
        /// Signs: the public half's path.
        case signs(String)
        /// GitHub doesn't have the key yet: ask the person before adding it.
        case ask
        case problem(SigningProblem)
    }

    /// `grant` asks GitHub for the permission to add signing keys: nil when approved, otherwise why not.
    /// `stage` names what's happening for the screen.
    static func run(
        login: String, name: String, email: String, register: Bool, place p: ForgeSigningKey.Place = .person,
        stage: @escaping @Sendable (String) -> Void = { _ in }, grant: @escaping @Sendable () async -> String?
    ) async -> Outcome {
        if !ForgeSigningKey.exists(p) {
            stage("Making your key…")
            if let why = await ForgeSigningKey.make(comment: "commit signing key for @\(login)", in: p) {
                return .problem(SigningProblem(text: why, fix: .tryAgain))
            }
        }
        stage("Looking for the key on GitHub…")
        switch await ForgeSigningKey.state(p) {
        case .onGitHub: break
        case .failed(let why):
            return .problem(SigningProblem(text: "Forge couldn't read your GitHub signing keys: \(why)", fix: .tryAgain))
        case .notOnGitHub, .needsPermission:
            guard register else { return .ask }
            if let stop = await add(login: login, place: p, stage: stage, grant: grant) { return .problem(stop) }
        }
        stage("Handing the key to your Mac's SSH agent…")
        if let why = await ForgeSigningKey.loadIntoAgent(p) { return .problem(SigningProblem(text: why, fix: .tryAgain)) }
        stage("Signing a test commit…")
        if let why = await GitHub.signCheck(name: name, email: email, signing: .forgeKey, key: p.publicKeyURL.path, env: p.env) {
            return .problem(SigningProblem(text: "A test commit with the key didn't sign: \(why)", fix: .tryAgain))
        }
        return .signs(p.publicKeyURL.path)
    }

    /// Adds the key to GitHub, asking for the permission once if the sign-in lacks it. Nil when GitHub has it.
    private static func add(
        login: String, place p: ForgeSigningKey.Place, stage: @escaping @Sendable (String) -> Void,
        grant: @escaping @Sendable () async -> String?
    ) async -> SigningProblem? {
        stage("Adding the key to @\(login) on GitHub…")
        var result = await ForgeSigningKey.register(title: ForgeSigningKey.title, in: p)
        if result == .needsPermission {
            stage("Waiting for you to approve on GitHub…")
            if let why = await grant() { return SigningProblem(text: why, fix: .permission) }
            stage("Adding the key to @\(login) on GitHub…")
            result = await ForgeSigningKey.register(title: ForgeSigningKey.title, in: p)
        }
        switch result {
        case .done: return nil
        case .needsPermission:
            return SigningProblem(
                text: "GitHub still doesn't let Forge add signing keys to @\(login). Approve the permission while signed in to GitHub as @\(login).",
                fix: .permission)
        case .inUse:
            if await ForgeSigningKey.state(p) == .onGitHub { return nil }
            return SigningProblem(text: "GitHub says this key is already on another GitHub account, so it can't go on @\(login).", fix: .newKey)
        case .failed(let why):
            return SigningProblem(text: "GitHub didn't add the key: \(why)", fix: .tryAgain)
        }
    }
}

/// The permission to add signing keys (`admin:ssh_signing_key`), asked of the account setup uses: through GitHub
/// CLI for an account it signed in, through Forge's own sign-in for one added in Forge. Asking GitHub CLI for an
/// account it doesn't have would grant the permission to some other account, or to none.
enum SigningPermission {
    static let scopes = "admin:ssh_signing_key"

    enum Route: Equatable {
        /// GitHub CLI's sign-in of that account.
        case cli(String?)
        /// Forge's own sign-in, kept in this Keychain item.
        case forge(String)
    }

    static func route(account: String?, cliAccounts: [String]) -> Route {
        guard let account, !cliAccounts.contains(where: { $0.lowercased() == account.lowercased() }) else { return .cli(account) }
        return .forge(GitHubAccountRecord.item(account))
    }

    /// Nil when GitHub approved; otherwise why not. `onCode` gets the one-time code and the page to type it on.
    static func grant(account: String?, onCode: @escaping @Sendable (String, String) -> Void) async -> String? {
        switch route(account: account, cliAccounts: await GitHub.cliAccounts()) {
        case .cli:
            return await GitHubSignIn.run(.signingKeyPermission) { onCode($0, GitHubSignIn.devicePage) }
        case .forge(let item):
            guard let account else { return "Pick a GitHub account first." }
            do {
                let code = try await GitHubLogin.start(scopes: GitHubLogin.scopes + " " + scopes)
                onCode(code.userCode, code.verificationURL)
                let tokens = try await GitHubLogin.finish(code, item: "")
                let me = try await GitHubProjectsAPI(token: { tokens.accessToken }).viewer()
                guard me.login.lowercased() == account.lowercased() else {
                    return "GitHub approved it for @\(me.login), not @\(account). Sign in to GitHub as @\(account) and try again."
                }
                guard GitHubLogin.save(tokens, item: item) else { return "Forge couldn't keep the new sign-in in your Keychain." }
                GitHub.forget()
                return nil
            } catch is CancellationError {
                return "Cancelled."
            } catch {
                return "\(error)"
            }
        }
    }
}
