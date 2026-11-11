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

    /// Columns the Workflow Studio screen can turn off. The rest are always on.
    static let optionalColumns = ["Triage", "AI Review", "QA", "Human Review", "Merging"]

    /// Who works a column: an agent, you, or nobody (the end).
    static func who(_ name: String) -> String {
        switch name {
        case "Backlog", "Human Review": return "you"
        case "Done": return "end"
        default: return "agent"
        }
    }

    /// The columns agents pick cards from, without the ones turned off, in pipeline order.
    static func activeColumns(off: [String]) -> [String] { agentColumns.filter { !off.contains($0) } }

    /// Where a card goes instead of a column that's off: the next column on after it.
    static func skipTarget(_ name: String, off: [String]) -> String {
        let forward = ["In Progress", "AI Review", "QA", "Human Review", "Merging", "Done"]
        guard let i = forward.firstIndex(of: name) else { return "Done" }
        return forward[(i + 1)...].first { !off.contains($0) } ?? "Done"
    }

    /// One plain line saying what happens to cards while a column is off.
    static func skipLine(_ name: String, off: [String]) -> String {
        switch name {
        case "Triage": return "Agents leave cards in Triage alone."
        case "Merging": return "You merge the pull request yourself, then move the card to Done."
        default:
            let order = ["In Progress", "AI Review", "QA", "Human Review"]
            let from = order.firstIndex(of: name).flatMap { i in order[..<i].last { !off.contains($0) } } ?? "In Progress"
            return "Cards skip \(name): \(from) → \(skipTarget(name, off: off))."
        }
    }

    /// The lines put in front of the lead's instructions when columns are off, so it routes around them.
    static func routingNote(off: [String]) -> String? {
        let skipped = optionalColumns.filter { off.contains($0) }
        guard !skipped.isEmpty else { return nil }
        var lines = [
            "## This board's stages", "", "These stages are turned off on this board: " + skipped.map { "`\($0)`" }.joined(separator: ", ") + ".",
        ]
        for s in skipped {
            switch s {
            case "Triage": lines.append("- Leave tickets in `Triage` alone; never work them.")
            case "Merging":
                lines.append(
                    "- Never move a ticket to `Merging` and never merge a pull request: the person merges it and moves the ticket to `Done`.")
            default:
                lines.append("- Wherever these instructions say to move a ticket to `\(s)`, move it to `\(skipTarget(s, off: off))` instead.")
            }
        }
        return lines.joined(separator: "\n") + "\n\n"
    }

    /// The columns a board must have: without them there's nothing to pick up and nowhere to finish.
    /// The rest are optional; a stage whose column is missing just doesn't run on that board.
    static let requiredColumns = ["Backlog", "Todo", "In Progress", "Done"]

    /// Required columns the board doesn't have.
    static func missingRequired(existing: [String]) -> [Column] {
        missing(existing: existing).filter { requiredColumns.contains($0.name) }
    }

    /// One plain line saying what Forge will and won't do on a board missing optional columns (nil when none are).
    static func withoutLine(existing: [String]) -> String? {
        let gone = missing(existing: existing).map(\.name).filter { !requiredColumns.contains($0) }
        let steps = gone.filter { $0 != "Triage" }
        var parts: [String] = []
        if !steps.isEmpty {
            let one = steps.count == 1
            parts.append(
                "Forge will work on Todo and In Progress cards. \(listed(steps)) \(one ? "has" : "have") no column here, so Forge won't move "
                    + "cards into \(one ? "it" : "them"). You can still run \(one ? "that step" : "those steps") from the Orchestrator.")
        }
        if gone.contains("Triage") { parts.append("Triage has no column here, so Forge won't plan cards first.") }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    /// "A", "A and B", "A, B and C".
    static func listed(_ names: [String]) -> String {
        names.count < 2 ? names.joined() : names.dropLast().joined(separator: ", ") + " and " + names.last!
    }

    /// Columns the team doesn't have yet, by name (case and spacing don't matter).
    static func missing(existing: [String]) -> [Column] {
        let have = Set(existing.map(normalized))
        return columns.filter { !have.contains(normalized($0.name)) }
    }

    static func normalized(_ s: String) -> String {
        s.lowercased().filter { !$0.isWhitespace }
    }
}
