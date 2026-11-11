import Foundation

extension Checks {
    /// A board that has only some of Forge's columns, like a shared team board nobody wants changed.
    static let sharedBoard = ["Backlog", "Triage", "Todo", "In Progress", "Done"]

    /// Item 1: setup goes on without the optional columns, and says what Forge will and won't do.
    static func missingColumnSetupChecks(_ check: (String, Bool) -> Void) {
        check("a team with only the required columns can continue", ProjectScreen.canContinue(team: "team-atc", existing: sharedBoard))
        check(
            "a team missing In Progress still can't continue",
            !ProjectScreen.canContinue(team: "team-atc", existing: ["Backlog", "Todo", "Done"]))
        check("the required columns are Backlog, Todo, In Progress and Done", Pipeline.requiredColumns == ["Backlog", "Todo", "In Progress", "Done"])
        check(
            "a Basecamp card table with only the required columns can continue",
            BasecampProjectScreen.canContinue(hasTable: true, existing: sharedBoard))
        check("no card table, no Continue", !BasecampProjectScreen.canContinue(hasTable: false, existing: sharedBoard))
        check(
            "a GitHub project with only the required Status options can continue",
            GitHubProjectScreen.canContinue(hasStatus: true, existing: sharedBoard, movers: [], repo: "acme/app"))
        check(
            "GitHub automations that move cards still block Continue",
            !GitHubProjectScreen.canContinue(hasStatus: true, existing: sharedBoard, movers: ["Item added"], repo: "acme/app"))
        check(
            "setup says what Forge will and won't do without the columns",
            Pipeline.withoutLine(existing: sharedBoard)
                == "Forge will work on Todo and In Progress cards. AI Review, QA, Human Review, Rework and Merging have no column "
                + "here, so Forge won't move cards into them. You can still run those steps from the Orchestrator.")
        check(
            "one missing column reads in the singular",
            Pipeline.withoutLine(existing: Pipeline.names.filter { $0 != "QA" })
                == "Forge will work on Todo and In Progress cards. QA has no column here, so Forge won't move cards into it. "
                + "You can still run that step from the Orchestrator.")
        check("a board with every column needs no line", Pipeline.withoutLine(existing: Pipeline.names) == nil)
        check(
            "only Triage missing: Forge just leaves triage alone",
            Pipeline.withoutLine(existing: Pipeline.names.filter { $0 != "Triage" }) == "Triage has no column here, so Forge won't plan cards first.")
        var c = SetupChoices()
        c.boardColumns = sharedBoard
        let saved = (try? JSONEncoder().encode(c)).flatMap { try? JSONDecoder().decode(SetupChoices.self, from: $0) }
        check("setup keeps the board's columns", saved?.boardColumns == sharedBoard)
        let old = #"{"columnsReady":true,"repoChecked":true,"workerChecked":true,"signingChecked":true}"#
        check("settings saved before this still load", (try? JSONDecoder().decode(SetupChoices.self, from: Data(old.utf8))) != nil)
    }
}
