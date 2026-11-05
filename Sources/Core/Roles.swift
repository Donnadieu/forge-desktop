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

/// One role's provider: the account it uses (its provider comes with it) and its model ("" or nil = the usual).
struct RoleChoice: Codable, Equatable, Sendable {
    var role: StageRole
    var accountID: String
    var model: String?
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

    /// The prefix a role's account variables reach the engine under: `FORGE_ROLE_<n>_`.
    static func rolePrefix(_ n: Int) -> String { "FORGE_ROLE_\(n)_" }
}
