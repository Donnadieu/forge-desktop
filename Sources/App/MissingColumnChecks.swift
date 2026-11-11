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

extension Checks {
    /// Item 2: in Workflow Studio a stage with no column is off by itself, says why, and comes back with its column.
    static func missingColumnStudioChecks(_ check: (String, Bool) -> Void) {
        var c = SetupChoices()
        (c.teamID, c.teamName, c.projectName) = ("team-atc", "ATC Rewrite", "ATC Rewrite")
        check("settings saved before this show every stage as on", c.stageState("AI Review") == .on)
        c.boardColumns = sharedBoard
        check(
            "a stage with no column is unavailable, with its reason",
            c.stageState("AI Review") == .unavailable("No AI Review column on ATC Rewrite"))
        check("Rework with no column is unavailable too", c.stageState("Rework") == .unavailable("No Rework column on ATC Rewrite"))
        check("a stage the board has stays on", c.stageState("Triage") == .on)
        check("required stages are never unavailable", c.stageState("In Progress") == .on)
        c.stagesOff = ["QA", "Triage"]
        check("the person's own off choice still shows where the column exists", c.stageState("Triage") == .off)
        check("a missing column wins over the person's choice on screen", c.stageState("QA") == .unavailable("No QA column on ATC Rewrite"))
        check(
            "the unavailable stages are the missing optional ones, in pipeline order",
            c.unavailableStages == ["AI Review", "QA", "Human Review", "Rework", "Merging"])
        check("a new board read with the same columns changes nothing", !c.refreshColumns(sharedBoard + ["Canceled"]))
        check("a new column on the board is noticed", c.refreshColumns(sharedBoard + ["AI Review"]))
        check("its stage is available again", c.stageState("AI Review") == .on)
        check("the person's own choice comes back with its column", c.refreshColumns(Pipeline.names) && c.stageState("QA") == .off)
        check("the person's choices are never rewritten by the board", c.stagesOff == ["QA", "Triage"])
        var basecamp = c
        (basecamp.tracker, basecamp.projectName, basecamp.boardColumns) = (.basecamp, "Client site", sharedBoard)
        check("on Basecamp the reason names the project", basecamp.stageState("QA") == .unavailable("No QA column on Client site"))
    }
}
