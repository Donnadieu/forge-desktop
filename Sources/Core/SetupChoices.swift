import Foundation

/// What setup decided, kept in `setup.json` in Forge's folder. Never a secret: keys live in the Keychain.
struct SetupChoices: Codable, Equatable, Sendable {
    // 1. Where the cards live (optional: added in 0.2.15; nil = Linear). See Tracker.swift.
    var tracker: Tracker?
    /// The Basecamp account, person, project and columns, when the cards live in Basecamp.
    var basecamp: BasecampBoard?
    /// The GitHub project, repo and columns, when the cards are GitHub issues (optional: added in 0.2.16).
    var githubBoard: GitHubBoard?
    /// The tracker connection the project uses (`TrackerRecord.id`; optional: added with workspaces; nil = the
    /// one connection of its kind carried over from before). See Workspaces.swift.
    var connectionID: String?
    // Linear
    var linearUser: String?
    var linearOrg: String?
    /// The workspace's part of Linear links (linear.app/<key>/…); optional so older settings still load.
    var linearURLKey: String?
    // 2. Project and statuses
    var teamID: String?
    var teamName: String?
    var projectID: String?
    var projectName: String?
    var projectSlug: String?
    var columnsReady = false
    // 3. GitHub and who signs
    var githubLogin: String?
    var authorName: String?
    var authorEmail: String?
    var signing: Signing?
    /// GPG key id, or the path of the public half of the key Forge made.
    var signingKey: String?
    // 4. The repo
    var repo: String?
    var defaultBranch: String?
    var repoChecked = false
    // 5. The intelligence provider that does the work, and how it signs in (mirrors the account below)
    var worker: Worker?
    /// The account (sign-in or key) this project's intelligence provider uses: an `AIAccount.id` in
    /// `store.json` (optional: added in 0.2.17; nil = carried over by `SetupStore.migrate`). See Accounts.swift.
    var accountID: String?
    var model: String?
    /// Stages with their own provider, account and model (optional: added with workspaces; nil = none). Roles.swift.
    var roles: [RoleChoice]?
    var workerChecked = false
    // 6. Ready for agents (optional so settings saved before this screen existed still load)
    /// The repo was read and its card made, or the person chose "Skip for now".
    var repoReady: Bool?
    /// The Linear card that gets the repo ready, when one was made.
    var repoReadyCard: String?
    // The Workflow Studio screen (optional: added after 0.2.4).
    /// Optional columns turned off; cards skip them.
    var stagesOff: [String]?
    /// How many agents work at once (each takes one card).
    var agentsAtOnce: Int?
    // Harness engineering, per repo (optional: added after 0.2.5). See Harness.swift.
    var harness: [String: HarnessRecord]?
    // Forge moves cards out of Backlog, from Workflow Studio (optional: added after 0.2.11; nil = off).
    /// Unassigned Backlog cards that aren't marked ready go to Triage, so an agent plans them.
    var sendNewToTriage: Bool?
    /// Backlog cards marked ready go to Todo, so an agent builds them.
    var startReady: Bool?
    // What others see, from Workflow Studio (optional: added in 0.2.23; nil = Forge's defaults).
    /// "Keep Forge invisible": no Forge label, words or folder paths in anything others read; commits as the person.
    var invisible: Bool?
    /// The label pull requests get; "" = none, nil = `forge` (none when invisible).
    var prLabel: String?
    /// Put before the card's id in branch names (`omar/` → `omar/bc-123`); nil or "" = the tracker's own name.
    var branchPrefix: String?

    enum Signing: String, Codable, CaseIterable, Sendable {
        /// A key Forge makes, kept in the Keychain and registered on the person's GitHub.
        case forgeKey
        /// The person's own GPG key, already on their GitHub.
        case ownGPG
        /// No signature, chosen knowingly.
        case unsigned
    }

    enum Worker: String, Codable, CaseIterable, Sendable {
        /// `apiKey` is Claude Code on an Anthropic key; `codexKey` is Codex on an OpenAI key; `openrouter` is
        /// Claude Code on an OpenRouter key (added in 0.2.17).
        case claude, codex, kimi, apiKey, codexKey, openrouter

        /// The intelligence provider itself (Claude Code, Codex, Kimi or OpenRouter), whichever way it signs in.
        var agent: Worker {
            switch self {
            case .claude, .apiKey: return .claude
            case .codex, .codexKey: return .codex
            case .kimi: return .kimi
            case .openrouter: return .openrouter
            }
        }

        /// It signs in with a key kept in the Keychain rather than in the browser.
        var usesKey: Bool { self == .apiKey || self == .codexKey || self == .kimi || self == .openrouter }

        /// The provider and the way it signs in, as one choice.
        static func with(_ agent: Worker, key: Bool) -> Worker {
            switch agent.agent {
            case .claude: return key ? .apiKey : .claude
            case .codex: return key ? .codexKey : .codex
            case .openrouter: return .openrouter
            default: return .kimi
            }
        }
    }
    /// The optional columns that are on. Backlog, Todo, In Progress, Rework and Done always are.
    func stageOn(_ name: String) -> Bool { !(stagesOff ?? []).contains(name) }

    /// The first screen that still needs an answer (6 = the board).
    var nextScreen: Int {
        if trackerUser == nil { return 0 }
        if projectSlug == nil || !columnsReady { return 1 }
        if githubLogin == nil || signing == nil { return 2 }
        if repo == nil || !repoChecked { return 3 }
        if worker == nil || !workerChecked { return 4 }
        if repoReady != true { return 5 }
        return 6
    }

    static var file: URL { Paths.home.appendingPathComponent("setup.json") }

    static func load() -> SetupChoices {
        guard let d = try? Data(contentsOf: file), let c = try? JSONDecoder().decode(SetupChoices.self, from: d) else { return SetupChoices() }
        return c
    }

    func save() {
        try? FileManager.default.createDirectory(at: Paths.home, withIntermediateDirectories: true)
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try? enc.encode(self).write(to: SetupChoices.file, options: .atomic)
    }
}
