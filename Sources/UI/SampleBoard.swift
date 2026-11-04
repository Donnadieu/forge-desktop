import Foundation

/// The board render mode draws: a project mid-run, with one card held by the lead and its helpers.
enum SampleBoard {
    static func card(
        _ n: Int, _ title: String, _ state: String, activity: String? = nil, pr: Bool = false, helpers: [EngineState.Helper] = []
    ) -> EngineState.Card {
        EngineState.Card(
            id: "c\(n)", identifier: "FDT-\(n)", title: title, state: state, url: "https://linear.app/acme/issue/FDT-\(n)",
            assignee: activity == nil ? nil : "Sam Rivera", branchName: "forge/FDT-\(n)",
            prUrl: pr ? "https://github.com/acme/forge-desktop-e2e/pull/\(n)" : nil, activity: activity,
            agent: activity == nil ? nil : .init(started_at: "2026-11-03T15:02:00Z", turn: 4, attempt: 1),
            helpers: helpers,
            recent: activity == nil
                ? nil
                : [
                    .init(at: "2026-11-03T15:02:10Z", line: "Reading login.tsx"),
                    .init(at: "2026-11-03T15:03:40Z", line: "Editing login.tsx"),
                    .init(at: "2026-11-03T15:05:02Z", line: "Sending a helper: Write the tests"),
                    .init(at: "2026-11-03T15:05:09Z", line: activity ?? ""),
                ])
    }

    /// The same board while Linear refuses to answer.
    static var problem: EngineState {
        var s = state
        s.board?.problem = "Linear said: usage limit exceeded"
        return s
    }

    static var state: EngineState {
        let held = card(
            3, "Reject an empty password on the login page", "In Progress", activity: "Editing the README while helpers work", pr: true,
            helpers: [
                .init(id: "h1", description: "Write the tests for the login check", running: true),
                .init(id: "h2", description: "Check the error message wording", running: false),
            ])
        let cards: [String: [EngineState.Card]] = [
            "Backlog": [card(7, "Dark mode", "Backlog")],
            "Todo": [card(4, "Show the version in the footer", "Todo"), card(5, "Add a health check page", "Todo")],
            "In Progress": [held],
            "AI Review": [],
            "QA": [],
            "Human Review": [card(2, "Fix the typo on the home page", "Human Review", pr: true)],
            "Done": [card(1, "Add a README", "Done", pr: true)],
        ]
        return EngineState(
            status: "running",
            running: [
                .init(issue_id: "c3", issue_identifier: "FDT-3", issue_title: held.title, last_message: nil, activity: held.activity, turn_count: 4)
            ],
            poll: nil,
            board: .init(columns: Pipeline.names.map { .init(name: $0, cards: cards[$0] ?? []) }, read_at: nil, problem: nil),
            usage: nil, totals: nil,
            rate_limits: [
                "five_hour": .init(percent: 42, resetsAt: nil, status: "allowed"), "seven_day": .init(percent: 18, resetsAt: nil, status: "allowed"),
            ])
    }
}
