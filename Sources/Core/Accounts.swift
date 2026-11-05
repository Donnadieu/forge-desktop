import Foundation

/// What does the work on a project's cards: Claude Code, Codex, Kimi, or Claude Code on OpenRouter.
enum IntelligenceProvider: String, Codable, CaseIterable, Sendable {
    case claude, codex, kimi, openrouter

    /// The name on screen.
    var name: String {
        switch self {
        case .claude: return "Claude Code"
        case .codex: return "Codex"
        case .kimi: return "Kimi"
        case .openrouter: return "OpenRouter"
        }
    }

    /// Claude Code and Codex can sign in with the browser; Kimi and OpenRouter take a key.
    var signsInWithBrowser: Bool { self == .claude || self == .codex }

    /// What its key is called.
    var keyName: String {
        switch self {
        case .claude: return "Anthropic API key"
        case .codex: return "OpenAI API key"
        case .kimi: return "Moonshot key"
        case .openrouter: return "OpenRouter key"
        }
    }

    /// The models setup offers (the first is the default; "" = the provider's usual model).
    var models: [String] {
        switch self {
        case .claude: return ["claude-sonnet-5", "claude-opus-5"]
        case .codex: return [""]
        case .kimi: return ["kimi-k2.7-code"]
        case .openrouter: return ["anthropic/claude-sonnet-5", "anthropic/claude-opus-5"]
        }
    }

    /// The provider and the way it signs in, as the one `SetupChoices.Worker` the rest of Forge switches on.
    func worker(key: Bool) -> SetupChoices.Worker {
        switch self {
        case .claude: return key ? .apiKey : .claude
        case .codex: return key ? .codexKey : .codex
        case .kimi: return .kimi
        case .openrouter: return .openrouter
        }
    }

    init(_ worker: SetupChoices.Worker) {
        switch worker.agent {
        case .codex: self = .codex
        case .kimi: self = .kimi
        case .openrouter: self = .openrouter
        default: self = .claude
        }
    }
}

/// One way into a provider: a browser sign-in or an API key. Never the secret itself: that lives in the
/// Keychain under `secretItem`. A browser sign-in has its own login folder, so signing in to one account never
/// signs out another, and the person's own Claude Code and Codex logins on this Mac are never touched.
struct AIAccount: Codable, Equatable, Identifiable, Sendable {
    enum Method: String, Codable, Sendable { case browser, key }

    var id: String
    var provider: IntelligenceProvider
    var method: Method
    /// The person's name for it ("Work", "Personal").
    var name: String
    /// The Keychain item with its sign-in or key. Nil for a Codex browser sign-in: Codex keeps that in `folder`.
    var secretItem: String?
    /// Its own login folder under `Paths.accounts` (Claude Code's CLAUDE_CONFIG_DIR, Codex's CODEX_HOME). Nil for
    /// an account carried over from before 0.2.17, which keeps working the way it did until it signs in again.
    var folder: String?

    var worker: SetupChoices.Worker { provider.worker(key: method == .key) }

    /// The login folder's full path, if it has one.
    var folderURL: URL? { folder.map { Paths.accounts.appendingPathComponent($0) } }

    /// One plain line under its name.
    var line: String {
        switch (method, provider) {
        case (.key, _): return "\(provider.keyName) · in your Keychain"
        case (.browser, .codex): return "Signed in with the browser · its own login"
        default: return "Signed in with the browser · in your Keychain"
        }
    }

    /// A new account: its own Keychain item and login folder, both named after its id.
    static func new(_ provider: IntelligenceProvider, method: Method, name: String, id: String = UUID().uuidString.lowercased()) -> AIAccount {
        let browserCodex = provider == .codex && method == .browser
        return AIAccount(
            id: id, provider: provider, method: method, name: name, secretItem: browserCodex ? nil : "ai-account-\(id)",
            folder: method == .browser ? id : nil)
    }

    /// Ready for a browser sign-in: an account carried over gets its own login folder and item first.
    func preparedForSignIn() -> AIAccount {
        var a = self
        if a.folder == nil { a.folder = a.id }
        if a.secretItem == nil, a.provider == .claude { a.secretItem = "ai-account-\(a.id)" }
        return a
    }
}

/// A tracker Forge is signed in to (Linear, Basecamp or GitHub Issues). Never a secret.
struct TrackerRecord: Codable, Equatable, Sendable {
    var id: String
    var kind: Tracker
    var org: String?
    var user: String?
}

/// A project on a tracker, mapped to one GitHub repo, with one intelligence provider and the account it uses.
struct ProjectRecord: Codable, Equatable, Sendable {
    /// `<tracker>:<project id on that tracker>`.
    var id: String
    var trackerID: String
    var name: String
    var repo: String?
    var defaultBranch: String?
    var provider: IntelligenceProvider?
    var accountID: String?
    var model: String?
}

/// How setup's answers relate, kept in `store.json` in Forge's folder: trackers → projects (each mapped to one
/// repo) → one intelligence provider per project → the account it uses. `setup.json` stays the working copy of
/// the project Forge runs now; `sync` writes it back here, `adopt` brings a project's saved answers back.
struct SetupStore: Codable, Equatable, Sendable {
    var version = 1
    var trackers: [TrackerRecord] = []
    var projects: [ProjectRecord] = []
    var accounts: [AIAccount] = []
    /// The project Forge runs now (`ProjectRecord.id`).
    var activeProject: String?

    static var file: URL { Paths.home.appendingPathComponent("store.json") }

    func accounts(for p: IntelligenceProvider) -> [AIAccount] { accounts.filter { $0.provider == p } }

    func account(_ id: String?) -> AIAccount? { id.flatMap { id in accounts.first { $0.id == id } } }

    func project(_ id: String?) -> ProjectRecord? { id.flatMap { id in projects.first { $0.id == id } } }

    /// The id a project's record has: its tracker and its id there. Nil until a project is picked.
    static func projectID(_ c: SetupChoices) -> String? { c.projectSlug.map { "\(c.board.rawValue):\($0)" } }

    /// Adds an account, or replaces the one with the same id.
    mutating func put(_ a: AIAccount) {
        if let i = accounts.firstIndex(where: { $0.id == a.id }) { accounts[i] = a } else { accounts.append(a) }
    }

    /// Forgets an account and unassigns it from every project. The caller removes its secret and folder.
    mutating func remove(_ id: String) {
        accounts.removeAll { $0.id == id }
        for i in projects.indices where projects[i].accountID == id { projects[i].accountID = nil }
    }

    /// A name nobody else uses: "Claude Code 2" when "Claude Code" is taken.
    func freeName(_ p: IntelligenceProvider, _ typed: String) -> String {
        let base = typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? p.name : typed.trimmingCharacters(in: .whitespacesAndNewlines)
        let taken = Set(accounts(for: p).map(\.name))
        if !taken.contains(base) { return base }
        return (2...).lazy.map { "\(base) \($0)" }.first { !taken.contains($0) }!
    }

    /// Records the project Forge runs now (its tracker, repo, provider and account) as the active one.
    mutating func sync(_ c: SetupChoices) {
        if c.trackerUser != nil {
            let t = TrackerRecord(id: c.board.rawValue, kind: c.board, org: c.trackerOrg, user: c.trackerUser)
            if let i = trackers.firstIndex(where: { $0.id == t.id }) { trackers[i] = t } else { trackers.append(t) }
        }
        guard let id = Self.projectID(c) else { return }
        let account = account(c.accountID)
        let p = ProjectRecord(
            id: id, trackerID: c.board.rawValue, name: c.projectName ?? id, repo: c.repo, defaultBranch: c.defaultBranch,
            provider: account?.provider ?? c.worker.map(IntelligenceProvider.init), accountID: account?.id, model: c.model)
        if let i = projects.firstIndex(where: { $0.id == id }) { projects[i] = p } else { projects.append(p) }
        activeProject = id
    }

    /// Setup moved to another project Forge already knows: bring back its repo, provider, account and model, so
    /// each project keeps the account it was given. True when something came back.
    @discardableResult
    func adopt(into c: inout SetupChoices) -> Bool {
        guard let id = Self.projectID(c), id != activeProject, let p = project(id) else { return false }
        if let repo = p.repo {
            (c.repo, c.defaultBranch, c.repoChecked) = (repo, p.defaultBranch, true)
        }
        if let a = account(p.accountID) {
            (c.accountID, c.worker, c.model, c.workerChecked) = (a.id, a.worker, p.model, true)
        }
        return true
    }

    /// Builds the store from settings saved before 0.2.17 (one tracker, one project, one sign-in). Every key or
    /// sign-in already in the Keychain becomes an account under its old item name, so nothing is copied and
    /// nothing changes for the engine; the one the project used is chosen. `has` says whether an item exists.
    static func migrate(_ c: SetupChoices, has: (String) -> Bool) -> (store: SetupStore, accountID: String?) {
        var s = SetupStore()
        func carry(_ w: SetupChoices.Worker, name: String) -> String {
            let p = IntelligenceProvider(w)
            let id = "mac-\(w.rawValue)"
            if s.account(id) == nil {
                let item = legacyItem(w)
                s.accounts.append(AIAccount(id: id, provider: p, method: w.usesKey ? .key : .browser, name: name, secretItem: item, folder: nil))
            }
            return id
        }
        var chosen: String?
        if let w = c.worker { chosen = carry(w, name: legacyName(w)) }
        for w in [SetupChoices.Worker.claude, .apiKey, .codexKey, .kimi] where legacyItem(w).map(has) == true {
            _ = carry(w, name: legacyName(w))
        }
        var working = c
        working.accountID = chosen
        s.sync(working)
        return (s, chosen)
    }

    /// The Keychain item each way of signing in used before 0.2.17.
    static func legacyItem(_ w: SetupChoices.Worker) -> String? {
        switch w {
        case .claude: return Keychain.Item.claudeToken.rawValue
        case .apiKey: return Keychain.Item.anthropicKey.rawValue
        case .codexKey: return Keychain.Item.openaiKey.rawValue
        case .kimi: return Keychain.Item.kimiKey.rawValue
        case .codex, .openrouter: return nil
        }
    }

    static func legacyName(_ w: SetupChoices.Worker) -> String {
        switch w {
        case .claude: return "Claude Code sign-in"
        case .apiKey: return "Anthropic API key"
        case .codex: return "Codex sign-in on this Mac"
        case .codexKey: return "OpenAI API key"
        case .kimi: return "Moonshot key"
        case .openrouter: return "OpenRouter key"
        }
    }

    /// The store, or one migrated from `setup.json` the first time 0.2.17 opens (saved, with the account it chose).
    static func load(migrating c: inout SetupChoices, has: (String) -> Bool = Keychain.has(named:)) -> SetupStore {
        if let d = try? Data(contentsOf: file), let s = try? JSONDecoder().decode(SetupStore.self, from: d) { return s }
        let (s, chosen) = migrate(c, has: has)
        if c.accountID == nil, chosen != nil {
            c.accountID = chosen
            c.save()
        }
        s.save()
        return s
    }

    /// The saved store without changing anything (the engine's start reads it); migrated in memory if missing.
    static func saved(for c: SetupChoices) -> SetupStore {
        if let d = try? Data(contentsOf: file), let s = try? JSONDecoder().decode(SetupStore.self, from: d) { return s }
        return migrate(c, has: Keychain.has(named:)).store
    }

    /// The account the project Forge runs now uses: the one setup chose, or (settings older than 0.2.17) the
    /// account carried over for its way of signing in.
    func activeAccount(_ c: SetupChoices) -> AIAccount? {
        account(c.accountID) ?? c.worker.flatMap { w in account("mac-\(w.rawValue)") }
    }

    func save() {
        try? FileManager.default.createDirectory(at: Paths.home, withIntermediateDirectories: true)
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try? enc.encode(self).write(to: Self.file, options: .atomic)
    }
}
