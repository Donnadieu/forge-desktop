import Foundation

/// A group of board stages that can have its own intelligence provider, account and model (Omar's example: Codex
/// builds, Claude Code reviews). Stages no role takes are worked by the project's own provider ("every other
/// stage"). The engine picks the agent by the card's stage (engine/src/agent/roles.ts).
enum StageRole: String, Codable, CaseIterable, Sendable {
    case plans, builds, reviews, tests

    var name: String {
        switch self {
        case .plans: return "Plans"
        case .builds: return "Builds"
        case .reviews: return "Reviews"
        case .tests: return "Tests"
        }
    }

    /// The board stages it works.
    var stages: [String] {
        switch self {
        case .plans: return ["Triage"]
        case .builds: return ["In Progress", "Rework"]
        case .reviews: return ["AI Review"]
        case .tests: return ["QA"]
        }
    }
}

extension StageRole {
    /// The role that works a stage, if any.
    static func of(_ stage: String) -> StageRole? { allCases.first { $0.stages.contains(stage) } }

    /// What Workflow Studio shows beside a stage: a picker on a role's first stage, "Same as <first>" on its others,
    /// "Default provider" on the other agent stages, "you" on the person's, nothing at the end.
    enum Cell: Equatable {
        case picker(StageRole)
        case follows(String)
        case usesDefault, you, none
    }

    static func cell(_ stage: String) -> Cell {
        if let r = of(stage) { return r.stages.first == stage ? .picker(r) : .follows(r.stages[0]) }
        switch Pipeline.who(stage) {
        case "agent": return .usesDefault
        case "you": return .you
        default: return .none
        }
    }

    /// How many roles differ between two lists (unsaved changes on Workflow Studio).
    static func changes(_ a: [RoleChoice], _ b: [RoleChoice]) -> Int {
        allCases.filter { r in a.first { $0.role == r } != b.first { $0.role == r } }.count
    }
}

/// One role's provider: the account it uses (its provider comes with it) and its model ("" or nil = the usual).
struct RoleChoice: Codable, Equatable, Sendable {
    var role: StageRole
    var accountID: String
    var model: String?

    /// Workflow Studio's picker picks account and model in one list: each entry is "<account id>\t<model>".
    static func pickKey(_ accountID: String, _ model: String) -> String { accountID + "\t" + model }

    /// The role a picker entry stands for, or nil for "Default provider" ("").
    static func picked(_ key: String, role: StageRole) -> RoleChoice? {
        let parts = key.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 2, !parts[0].isEmpty else { return nil }
        return RoleChoice(role: role, accountID: parts[0], model: parts[1].isEmpty ? nil : parts[1])
    }
}

extension IntelligenceProvider {
    /// The engine's agent kind (OpenRouter is Claude Code on another key).
    var engineKind: String {
        switch self {
        case .claude, .openrouter: return "claude"
        case .codex: return "codex"
        case .kimi: return "kimi"
        }
    }
}

extension SetupChoices {
    /// The roles that have their own provider, each with its account found in `store`, in `StageRole` order.
    func roleAccounts(_ store: SetupStore) -> [(choice: RoleChoice, account: AIAccount)] {
        let mine = roles ?? []
        return StageRole.allCases.compactMap { r in
            guard let c = mine.first(where: { $0.role == r }), let a = store.account(c.accountID) else { return nil }
            return (c, a)
        }
    }

    /// The roles worth keeping: ones whose account still exists (a cleared account's role falls back to the default).
    func keptRoles(_ list: [RoleChoice], store: SetupStore) -> [RoleChoice]? {
        let kept = list.filter { store.account($0.accountID) != nil }
        return kept.isEmpty ? nil : kept
    }

    /// The prefix a role's account variables reach the engine under: `FORGE_ROLE_<n>_`.
    static func rolePrefix(_ n: Int) -> String { "FORGE_ROLE_\(n)_" }
}
