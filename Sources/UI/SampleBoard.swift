import Foundation

/// What render mode draws on the Orchestrator: the "AI Trading Bot" project in its states.
enum SampleBoard {
    static let base = "https://linear.app/acme/issue/AIT-"

    /// A time `seconds` ago, as the engine writes it.
    static func ago(_ seconds: TimeInterval) -> String { ISO8601DateFormatter().string(from: Date().addingTimeInterval(-seconds)) }

    static func card(
        _ n: Int, _ title: String, _ state: String, activity: String? = nil, pr: Bool = false, helpers: [EngineState.Helper] = [],
        turn: Int = 4
    ) -> EngineState.Card {
        EngineState.Card(
            id: "c\(n)", identifier: "AIT-\(n)", title: title, state: state, url: "\(base)\(n)",
            assignee: activity == nil ? nil : "Sam Rivera", branchName: "forge/AIT-\(n)",
            prUrl: pr ? "https://github.com/acme/ai-trading-bot/pull/\(n)" : nil, activity: activity,
            agent: activity == nil ? nil : .init(started_at: ago(turn == 4 ? 372 : 760), turn: turn, attempt: 1),
            helpers: helpers,
            recent: activity == nil
                ? nil
                : [
                    .init(at: ago(200), line: "Found where orders are placed: orders/place.py"),
                    .init(at: ago(166), line: "Sent a helper to write the tests"),
                    .init(at: ago(119), line: "Helper finished: the wording matches the API docs"),
                    .init(at: ago(41), line: "Editing orders/validate.py"),
                    .init(at: ago(0), line: activity ?? ""),
                ])
    }

    static let held = card(
        3, "Reject an order when the balance is too low", "In Progress", activity: "Writing the balance check in orders/validate.py",
        pr: true,
        helpers: [
            .init(id: "h1", description: "Write the tests for the balance check", running: true),
            .init(id: "h2", description: "Check the error message wording", running: false),
        ])
    static let second = card(
        5, "Add a stop-loss to the momentum strategy", "In Progress", activity: "Running pytest on tests/test_momentum.py", turn: 9)

    static func running(_ c: EngineState.Card) -> EngineState.RunningCard {
        .init(
            issue_id: c.id, issue_identifier: c.identifier, issue_title: c.title, last_message: nil, activity: c.activity,
            turn_count: c.agent?.turn, state: c.state, started_at: c.agent?.started_at, attempt: 1, helpers: c.helpers,
            recent: c.recent, tokens: .init(total_tokens: 105_600))
    }

    static func board(_ cards: [EngineState.Card], problem: String? = nil) -> EngineState.Board {
        .init(columns: Pipeline.names.map { n in .init(name: n, cards: cards.filter { $0.state == n }) }, read_at: nil, problem: problem)
    }

    /// Running: two agents at work, one card waiting for one, one for you.
    static var state: EngineState {
        let cards = [
            held, second,
            card(4, "Log every fill to a CSV file", "AI Review"),
            card(2, "Retry the exchange call when it times out", "Human Review", pr: true),
            card(6, "Show the open positions on startup", "Todo"),
            card(7, "Paper-trading mode", "Backlog"), card(8, "Backtest report as HTML", "Backlog"),
            card(1, "Read the API keys from the environment", "Done", pr: true),
        ]
        return EngineState(
            status: "running", started_at: ago(78 * 60), running: [running(held), running(second)], retrying: [], poll: nil,
            board: board(cards), usage: .init(last_24h: .init(runs: 6, inputTokens: 380_100, outputTokens: 32_500), all_time: nil),
            totals: nil,
            rate_limits: [
                "five_hour": .init(percent: 42, resetsAt: nil, status: "allowed"), "seven_day": .init(percent: 18, resetsAt: nil, status: "allowed"),
            ])
    }

    /// Stopped with nothing on the board.
    static var empty: EngineState {
        EngineState(
            status: "stopped", running: [], retrying: [], poll: nil, board: board([]),
            usage: .init(last_24h: .init(runs: 0, inputTokens: 700, outputTokens: 53), all_time: nil), totals: nil, rate_limits: nil)
    }

    /// Stopped with a few cards waiting in Backlog and Todo.
    static var few: EngineState {
        var s = empty
        s.board = board([
            card(6, "Show the open positions on startup", "Todo"), card(9, "Cap each order at 2% of the balance", "Todo"),
            card(7, "Paper-trading mode", "Backlog"), card(8, "Backtest report as HTML", "Backlog"),
        ])
        return s
    }

    /// Stopping: the agents finish what they're doing first.
    static var stopping: EngineState {
        var s = state
        s.status = "stopping"
        return s
    }

    /// Stopped with cards waiting: Start comes back.
    static var stopped: EngineState {
        var s = state
        s.status = "stopped"
        s.running = []
        return s
    }

    /// Linear refuses to answer.
    static var problem: EngineState {
        var s = state
        s.status = "running"
        s.board?.problem = "Linear said: usage limit exceeded"
        return s
    }

    /// GitHub's hourly rate limit ran out while reading the board.
    static var githubLimit: EngineState {
        var s = stopped
        s.board?.problem = "Forge couldn't read the board from GitHub Issues: GitHub said: API rate limit exceeded for user ID 1234567."
        return s
    }

    /// Cards the person can move: three pull requests to decide on, a card blocked by one of them,
    /// two cards triage marked ready and one it hasn't seen.
    static var moves: EngineState {
        var s = empty
        s.status = "running"
        var blocked = card(16, "Fix correctness defects in utils/changelog.py", "Todo")
        blocked.blockedBy = ["AIT-15"]
        var ready1 = card(17, "Reconcile the three changelog artifacts", "Backlog")
        ready1.labels = [CardMoves.readyLabel]
        var ready2 = card(18, "Add a pre-commit config", "Backlog")
        ready2.labels = [CardMoves.readyLabel]
        s.board = board([
            card(15, "Add pytest tests for utils/changelog.py", "Human Review", pr: true),
            card(19, "Pin the changelog limits", "Human Review", pr: true),
            card(20, "Add pytest config and CI", "Human Review", pr: true),
            blocked, ready1, ready2, card(21, "Document the paper-trading mode", "Backlog"),
        ])
        return s
    }

    /// A shared team board with no column after In Progress: two cards wait on you, one agent still works.
    static var parked: EngineState {
        var s = state
        s.running = [running(held)]
        var p1 = card(11, "Paginate the trade history", "In Progress", pr: true)
        p1.parked = .init(next: "AI Review", line: "The pull request is open as a draft. Pick the next step.", since: SampleBoard.ago(40 * 60))
        var p2 = card(12, "Show fees on each fill", "In Progress", pr: true)
        p2.parked = .init(next: "AI Review", line: "Built and tested; the draft pull request waits for you.", since: SampleBoard.ago(90 * 60))
        s.board = board([held, p1, p2, card(6, "Show the open positions on startup", "Todo"), card(7, "Paper-trading mode", "Backlog")])
        return s
    }

    /// The work account hit its spend limit at 8:13 PM: three cards wait for 11:40 PM, one agent still works.
    static var limited: EngineState {
        var s = state
        s.running = [running(second)]
        var c4 = card(4, "Log every fill to a CSV file", "AI Review")
        c4.agent = nil
        let cards = [
            held, second, c4, card(2, "Retry the exchange call when it times out", "Human Review", pr: true),
            card(6, "Show the open positions on startup", "Todo"), card(9, "Cap each order at 2% of the balance", "Todo"),
            card(7, "Paper-trading mode", "Backlog"),
        ]
        s.board = board(cards)
        // 11:40 PM today (tomorrow's once that has passed), as in the evening it happened.
        var reset = Calendar.current.date(bySettingHour: 23, minute: 40, second: 0, of: Date()) ?? Date()
        if reset < Date() { reset = reset.addingTimeInterval(86400) }
        let text =
            "You've hit your individual spend limit · ask your admin to raise it at https://claude.ai/admin-settings/usage · your 5-hour limit resets 11:40pm (America/New_York) (API status 429)"
        s.retrying = ["AIT-3", "AIT-4", "AIT-6"].map { .init(issue_identifier: $0, attempt: 1, due_at: nil, error: text, waiting_for_limit: true) }
        let iso = ISO8601DateFormatter()
        s.limits = [
            .init(
                role: -1, kind: "spend", reason: "spend limit, ask your admin to raise it", message: text,
                link: "https://claude.ai/admin-settings/usage", resets_at: iso.string(from: reset), until: iso.string(from: reset),
                since: ago(180))
        ]
        s.rate_limits = ["five_hour": .init(percent: nil, resetsAt: nil, status: "rejected")]
        return s
    }

    /// A QA run filled the disk: the engine stopped it and new cards wait for space.
    static var diskFull: EngineState {
        var s = state
        s.running = Array(s.running.prefix(1))
        s.disk = .init(low_space: true, free_pct: 4, stopped: [.init(issue_identifier: "AIT-6", grew_gb: 78, why: "folder", at: ago(600))])
        return s
    }

    /// The agent's sign-in lapsed: cards wait to try again with the reason.
    static var signedOut: EngineState {
        var s = state
        s.running = []
        s.retrying = [.init(issue_identifier: "AIT-3", attempt: 2, due_at: nil, error: "Failed to authenticate: OAuth session expired")]
        return s
    }
}
