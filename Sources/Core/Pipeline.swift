import Foundation

/// The pipeline every card goes through: the ten columns, in order, with one plain line each.
/// Setup explains these and offers to create the ones a Linear team is missing.
struct Column: Equatable, Sendable {
    let name: String
    /// Linear's kind of status: backlog, unstarted, started, completed (or triage, a team switch).
    let kind: String
    let color: String
    let line: String
}

enum Pipeline {
    static let columns: [Column] = [
        Column(
            name: "Backlog", kind: "backlog", color: "#bec2c8",
            line: "Ideas and later work. Agents leave these alone; move a card to Todo when it should be built."),
        Column(
            name: "Triage", kind: "triage", color: "#fc7840",
            line: "Cards to look into first. The lead agent plans them, writes no code, and puts them back in Backlog marked ready."),
        Column(name: "Todo", kind: "unstarted", color: "#e2e2e2", line: "Ready to start. The lead agent picks these up."),
        Column(name: "In Progress", kind: "started", color: "#f2c94c", line: "An agent is writing the code and opening a pull request."),
        Column(name: "AI Review", kind: "started", color: "#bb87fc", line: "Another agent reviews the pull request and fixes what it finds."),
        Column(name: "QA", kind: "started", color: "#4ea7fc", line: "An agent tests the change the way a person would."),
        Column(
            name: "Human Review", kind: "started", color: "#0f783c",
            line: "Your turn: look at the pull request, then move the card to Merging or Rework."),
        Column(name: "Rework", kind: "started", color: "#eb5757", line: "You asked for changes. An agent makes them and sends it back for review."),
        Column(name: "Merging", kind: "started", color: "#26b5ce", line: "An agent merges the pull request once checks pass."),
        Column(name: "Done", kind: "completed", color: "#5e6ad2", line: "Merged. Nothing left to do."),
    ]

    static var names: [String] { columns.map(\.name) }

    /// Columns where agents work (the lead picks cards from these). Human Review waits for the person.
    static let agentColumns = ["Triage", "Todo", "In Progress", "AI Review", "QA", "Rework", "Merging"]
    static let doneColumns = ["Done"]

    /// Columns the team doesn't have yet, by name (case and spacing don't matter).
    static func missing(existing: [String]) -> [Column] {
        let have = Set(existing.map(normalized))
        return columns.filter { !have.contains(normalized($0.name)) }
    }

    static func normalized(_ s: String) -> String {
        s.lowercased().filter { !$0.isWhitespace }
    }
}
