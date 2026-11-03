import Foundation

/// What the engine sends: the board, the agents at work, and usage. Same shape from `GET /api/v1/state`
/// and every live frame (engine/src/server/engine-state.ts).
struct EngineState: Decodable, Sendable, Equatable {
    /// "running", "stopping" or "stopped".
    var status: String
    var running: [RunningCard]
    var poll: Poll?
    var board: Board?
    var usage: Usage?
    var totals: Totals?
    var rate_limits: [String: RateLimit]?

    struct RunningCard: Decodable, Sendable, Equatable {
        var issue_id: String?
        var issue_identifier: String
        var issue_title: String?
        var last_message: String?
        var activity: String?
        var turn_count: Int?
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
    }

    struct Agent: Decodable, Sendable, Equatable {
        var started_at: String
        var turn: Int
        var attempt: Int
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
