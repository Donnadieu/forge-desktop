import Foundation

/// Selftest checks for "Keep Forge invisible": what the settings block says, and that a file edited by hand with
/// 0.2.23 to 0.2.32's editor keeps those edits through a save from Workflow Studio.
@MainActor
extension Checks {
    static func workflowFileChecks(_ check: (String, Bool) -> Void) {
        var c = SetupChoices()
        (c.projectSlug, c.repo, c.worker, c.agentsAtOnce) = ("p", "acme/app", .claude, 4)
        check("by default the workflow file has no marks block (the engine keeps the forge label)", EngineSettings.marksLines(c).isEmpty)
        c.invisible = true
        c.branchPrefix = "omar/"
        check(
            "Keep Forge invisible and the branch prefix reach the engine",
            EngineSettings.marksLines(c) == ["marks:", "  invisible: true", "  branch_prefix: \"omar/\""])
        c.prLabel = "mine"
        check("an own pull request label is written as typed", EngineSettings.marksLines(c).contains("  pr_label: \"mine\""))
        c.prLabel = nil

        let lead = "# Lead\n\nDo the card.\n"
        func app(_ c: SetupChoices, part: String = "") -> String {
            EngineSettings.frontMatter(c, cardsFolder: "/cards") + WorkflowFile.partStart + "\n" + part + WorkflowFile.partEnd + "\n\n" + lead
        }
        let original = app(c)
        // The person raises max_turns, adds a polling setting and a line to the instructions.
        var mine = original.replacingOccurrences(of: "  max_turns: 20", with: "  max_turns: 30")
        mine = mine.replacingOccurrences(of: "  interval_ms: 30000", with: "  interval_ms: 30000\n  jitter_ms: 5")
        mine += "\nAlways run the linter first.\n"

        // Then Workflow Studio saves: 6 agents, invisible off, QA off.
        var studio = c
        (studio.agentsAtOnce, studio.invisible, studio.branchPrefix, studio.stagesOff) = (6, nil, nil, ["QA"])
        let merged = WorkflowFile.merge(edited: mine, app: app(studio, part: "QA is off.\n"))
        check(
            "a Studio save keeps the hand edits",
            merged.contains("  max_turns: 30") && merged.contains("  jitter_ms: 5") && merged.contains("Always run the linter first."))
        let active = merged.components(separatedBy: "\n").first { $0.hasPrefix("  active_states:") } ?? ""
        check(
            "and changes only what Studio owns",
            merged.contains("  max_concurrent_agents: 6") && !merged.contains("marks:") && !active.contains("\"QA\""))
        check(
            "the app's part of the instructions follows the stages", merged.contains(WorkflowFile.partStart + "\nQA is off.\n" + WorkflowFile.partEnd)
        )
        check("merging twice changes nothing more", WorkflowFile.merge(edited: merged, app: app(studio, part: "QA is off.\n")) == merged)

        // Someone who indents with four spaces.
        let wide = original.replacingOccurrences(of: "\n  ", with: "\n    ").replacingOccurrences(of: "\n      ", with: "\n        ")
        let wideMerged = WorkflowFile.merge(edited: wide, app: app(studio))
        check(
            "a Studio save into a four-space file keeps four spaces",
            wideMerged.contains("\n    max_concurrent_agents: 6") && !wideMerged.contains("\n  max_concurrent_agents"))
        let restored =
            WorkflowFile.split(WorkflowFile.merge(edited: original.replacingOccurrences(of: "  kind: claude\n", with: ""), app: original)).front ?? []
        check(
            "a key missing from the file is added under its group",
            YAMLBlocks.block(restored, "agent").map { restored[$0].contains("  kind: claude") } == true)

        let older = #"{"worker":"claude","stagesOff":["QA"],"agentsAtOnce":2,"workerChecked":true,"columnsReady":true,"repoChecked":true}"#
        let decoded = try? JSONDecoder().decode(SetupChoices.self, from: Data(older.utf8))
        check("settings saved by 0.2.22 still load, with Forge visible", decoded?.agentsAtOnce == 2 && decoded?.invisible == nil)
        var w = SetupChoices()
        WorkflowSettings(c).apply(to: &w)
        check("a workspace carries its What others see answers", w.invisible == true && w.branchPrefix == "omar/")
        check("a branch prefix keeps only what git takes", WhatOthersSee.cleanPrefix("om ar/#1!") == "omar/1")
        check(
            "the branch example matches the engine's",
            WhatOthersSee.branch(card: "BC-104", prefix: "omar/", tracker: "basecamp/bc-104") == "omar/bc-104")
        check("the signing key's name on GitHub is plain", !ForgeSigningKey.title.lowercased().contains("forge"))
        check("web requests don't name the app", !AppInfo.plainUserAgent.lowercased().contains("forge"))
    }
}
