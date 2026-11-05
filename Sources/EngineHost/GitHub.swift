import Foundation

/// GitHub and commit signing for setup screens 3 and 4, through the person's own `gh`, `git`, `gpg` and
/// `ssh-keygen`. V1 reuses the `gh` sign-in already on the Mac (docs/design-docs/decisions.md).
enum GitHub {
    struct User: Sendable, Equatable {
        let login: String
        let name: String
        let id: Int
        /// GitHub's private address for this account; always verified, so commits with it verify.
        var noreplyEmail: String { "\(id)+\(login)@users.noreply.github.com" }
    }

    struct Repo: Sendable, Hashable, Identifiable {
        let fullName: String
        let defaultBranch: String
        let canPush: Bool
        var id: String { fullName }
    }

    struct GPGKey: Sendable, Hashable, Identifiable {
        let id: String
        let name: String
        let email: String
    }

    /// The GitHub accounts `gh` is signed in to on this Mac, the active one first, then the ones Forge signed in
    /// to itself (`added`).
    static func accounts(adding added: [String] = []) async -> [String] {
        let mine = await cliAccounts()
        return mine + added.filter { a in !mine.contains { $0.lowercased() == a.lowercased() } }
    }

    /// The accounts the GitHub CLI has on this Mac, the active one first.
    static func cliAccounts() async -> [String] {
        let r = await Tools.run("gh", ["auth", "status", "--hostname", "github.com"], timeout: 20)
        var names: [String] = []
        var active: String?
        var last: String?
        for line in (r.out + r.err).split(separator: "\n") {
            if let range = line.range(of: "account ") {
                let name = line[range.upperBound...].split(separator: " ").first.map(String.init) ?? ""
                if !name.isEmpty { names.append(name) }
                last = name
            } else if line.contains("Active account: true") {
                active = last
            }
        }
        if let a = active, let i = names.firstIndex(of: a) { names.insert(names.remove(at: i), at: 0) }
        return names
    }

    /// The account setup picked; every GitHub call Forge makes uses its sign-in, without switching `gh`'s active account.
    nonisolated(unsafe) static var account: String?
    private static let tokens = TokenCache()

    /// The environment that makes `gh` and git act as `account`. The sign-in stays in memory, never on disk.
    /// An account Forge signed in to itself (`GitHubAccountRecord`) uses its own token from the Keychain.
    static func env() async -> [String: String] {
        guard let account else { return [:] }
        if let t = tokens.get(account) { return ["GH_TOKEN": t] }
        if let raw = Keychain.get(named: GitHubAccountRecord.item(account)),
            let t = try? JSONDecoder().decode(GitHubLogin.Tokens.self, from: Data(raw.utf8))
        {
            tokens.set(account, t.accessToken)
            return ["GH_TOKEN": t.accessToken]
        }
        let r = await Tools.run("gh", ["auth", "token", "--hostname", "github.com", "--user", account], timeout: 20)
        let t = r.out.trimmingCharacters(in: .whitespacesAndNewlines)
        guard r.ok, !t.isEmpty else { return [:] }
        tokens.set(account, t)
        return ["GH_TOKEN": t]
    }

    /// Drops remembered sign-ins (after GitHub granted a new permission, the old one is stale).
    static func forget() { tokens.clear() }

    static func gh(_ args: [String], timeout: TimeInterval = 30) async -> Tools.Result {
        await Tools.run("gh", args, env: await env(), timeout: timeout)
    }

    /// Who the chosen account is, or nil if `gh` isn't signed in.
    static func user() async -> User? {
        let r = await gh(["api", "user", "--jq", "[.login, (.name // \"\"), (.id|tostring)] | @tsv"], timeout: 20)
        let f = r.out.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\t")
        guard r.ok, f.count == 3, let id = Int(f[2]) else { return nil }
        return User(login: f[0], name: f[1].isEmpty ? f[0] : f[1], id: id)
    }

    /// Repos the person can see, most recently pushed first.
    static func repos() async -> [Repo] {
        let jq = ".[] | [.full_name, .default_branch, (.permissions.push|tostring)] | @tsv"
        let r = await gh(
            ["api", "--paginate", "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member", "--jq", jq],
            timeout: 60)
        return r.out.split(separator: "\n").compactMap { line in
            let f = line.components(separatedBy: "\t")
            return f.count == 3 ? Repo(fullName: f[0], defaultBranch: f[1], canPush: f[2] == "true") : nil
        }
    }

    /// One real call: does GitHub say this account may push to `repo`?
    static func canPush(_ repo: String) async -> Bool {
        let r = await gh(["api", "repos/\(repo)", "--jq", ".permissions.push"], timeout: 20)
        return r.ok && r.out.trimmingCharacters(in: .whitespacesAndNewlines) == "true"
    }

    /// The person's own GPG keys that can sign.
    static func gpgKeys() async -> [GPGKey] {
        let r = await Tools.run("gpg", ["--list-secret-keys", "--with-colons"], timeout: 20)
        var keys: [GPGKey] = []
        var current: String?
        for line in r.out.split(separator: "\n") {
            let f = line.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
            if f.first == "sec", f.count > 11, f[11].contains("s") || f[11].contains("S") {
                current = f[4]
            } else if f.first == "sec" {
                current = nil
            } else if f.first == "uid", let id = current, f.count > 9 {
                let uid = f[9]
                let email = uid.split(separator: "<").last.map { String($0.dropLast()) } ?? ""
                let name = uid.split(separator: "<").first.map { $0.trimmingCharacters(in: .whitespaces) } ?? uid
                keys.append(GPGKey(id: id, name: name, email: email))
                current = nil
            }
        }
        return keys
    }

    /// Proves the chosen identity really signs: one signed commit in a scratch repo, checked by git.
    static func signs(name: String, email: String, signing: SetupChoices.Signing, key: String?) async -> Bool {
        if signing == .unsigned { return true }
        guard let key else { return false }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("forge-sign-check-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let format = signing == .forgeKey ? "ssh" : "openpgp"
        let git = { (a: [String]) in await Tools.run("git", a, cwd: dir, timeout: 30) }
        _ = await git(["init", "-q"])
        for (k, v) in [
            ("user.name", name), ("user.email", email), ("user.signingkey", key), ("gpg.format", format), ("commit.gpgsign", "true"),
        ] {
            _ = await git(["config", "--local", k, v])
        }
        let commit = await git(["commit", "-q", "--allow-empty", "-m", "Forge signing check"])
        guard commit.ok else { return false }
        if signing == .forgeKey {
            // git can't check an SSH signature without a list of trusted keys; the agent signing it is the proof.
            let raw = await git(["cat-file", "commit", "HEAD"])
            return raw.out.contains("-----BEGIN SSH SIGNATURE-----")
        }
        let status = await git(["log", "-1", "--format=%G?"])
        return ["G", "U"].contains(status.out.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}

/// Sign-ins read from `gh`, kept in memory for this run of the app only.
final class TokenCache: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]
    func get(_ k: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return values[k]
    }
    func clear() {
        lock.lock()
        values = [:]
        lock.unlock()
    }
    func set(_ k: String, _ v: String) {
        lock.lock()
        values[k] = v
        lock.unlock()
    }
}
