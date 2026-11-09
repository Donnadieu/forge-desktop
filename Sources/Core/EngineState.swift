import Foundation

/// What the engine sends: the board, the agents at work, and usage. Same shape from `GET /api/v1/state`
/// and every live frame (engine/src/server/engine-state.ts).
struct EngineState: Decodable, Sendable, Equatable {
    /// "running", "stopping" or "stopped".
    var status: String
    /// When Start was last pressed (ISO 8601), while running.
    var started_at: String?
    var running: [RunningCard]
    /// Cards waiting to try again.
    var retrying: [Retry]?
    var poll: Poll?
    var board: Board?
    var usage: Usage?
    var totals: Totals?
    var rate_limits: [String: RateLimit]?
    /// Accounts at a usage, spend or rate limit (engine orchestrator/usage-limits.ts); their cards wait for it.
    var limits: [Limit]? = nil
    /// The disk's free space and the cards the engine stopped for filling it (engine workspace/runaway-guard.ts).
    var disk: Disk? = nil

    struct RunningCard: Decodable, Sendable, Equatable {
        var issue_id: String?
        var issue_identifier: String
        var issue_title: String?
        var last_message: String?
        var activity: String?
        var turn_count: Int?
        var state: String?
        var started_at: String?
        var attempt: Int?
        var helpers: [Helper]?
        var recent: [Line]?
        var tokens: Tokens?
    }

    struct Tokens: Decodable, Sendable, Equatable {
        var total_tokens: Int?
    }

    struct Retry: Decodable, Sendable, Equatable {
        var issue_identifier: String
        var attempt: Int?
        var due_at: String?
        var error: String?
        /// Waiting for its account's usage limit to reset, not retrying a failure.
        var waiting_for_limit: Bool? = nil
    }

    /// An account that hit a usage, spend or rate limit. `role` is the role's index (`SetupChoices.roleAccounts`),
    /// -1 for the project's own provider; `until` is when the waiting cards go again.
    struct Limit: Decodable, Sendable, Equatable {
        var role: Int
        var kind: String
        var reason: String
        var message: String?
        var link: String?
        var resets_at: String?
        var until: String
        var since: String
    }

    struct Disk: Decodable, Sendable, Equatable {
        /// Under 10% free: no new card starts.
        var low_space: Bool
        var free_pct: Int?
        var stopped: [Stopped]

        struct Stopped: Decodable, Sendable, Equatable {
            var issue_identifier: String
            var grew_gb: Double
            /// "folder" (grew more than 5 GB in one run) or "disk" (grew most while the disk was nearly full).
            var why: String
            var at: String
        }
    }

    struct Poll: Decodable, Sendable, Equatable {
        var lastPollAt: String?
        var lastPollError: String?
    }

    struct Board: Decodable, Sendable, Equatable {
        var columns: [Column]
        var read_at: String?
        var problem: String?
    }

    struct Column: Decodable, Sendable, Equatable, Identifiable {
        var name: String
        var cards: [Card]
        var id: String { name }
    }

    struct Card: Decodable, Sendable, Equatable, Identifiable {
        var id: String
        var identifier: String
        var title: String
        var state: String
        var url: String?
        var assignee: String?
        var branchName: String?
        var prUrl: String?
        var activity: String?
        var agent: Agent?
        var helpers: [Helper]
        var recent: [Line]?
        /// The card's labels (`ready-for-execution` after triage) and the unfinished cards blocking it.
        var labels: [String]?
        var blockedBy: [String]?
    }

    struct Agent: Decodable, Sendable, Equatable {
        var started_at: String
        var turn: Int
        var attempt: Int
        /// The agent's Claude Code session and folder: the card's session follows them (Sessions screen).
        var session_id: String? = nil
        var folder: String? = nil
        /// The person holds the wheel: the run waits for their messages.
        var hands_on: Bool? = nil
    }

    struct Helper: Decodable, Sendable, Equatable, Identifiable {
        var id: String
        var description: String
        var running: Bool
    }

    struct Line: Decodable, Sendable, Equatable, Hashable {
        var at: String
        var line: String
    }

    struct Usage: Decodable, Sendable, Equatable {
        var last_24h: Spend?
        var all_time: Spend?
    }

    struct Spend: Decodable, Sendable, Equatable {
        var runs: Int?
        var inputTokens: Int?
        var outputTokens: Int?
    }

    struct Totals: Decodable, Sendable, Equatable {
        var input_tokens: Int?
        var output_tokens: Int?
        var total_tokens: Int?
    }

    struct RateLimit: Decodable, Sendable, Equatable {
        var percent: Int?
        var resetsAt: String?
        var status: String?
    }

    static func decode(_ data: Data) throws -> EngineState {
        try JSONDecoder().decode(EngineState.self, from: data)
    }

    private struct Frame: Decodable {
        var type: String
        var state: EngineState
    }

    static func decodeFrame(_ data: Data) throws -> EngineState {
        try JSONDecoder().decode(Frame.self, from: data).state
    }

    var isRunning: Bool { status == "running" }

    /// Every card on the board, for lookups by id.
    var cards: [Card] { board?.columns.flatMap(\.cards) ?? [] }
}
