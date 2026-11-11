import Foundation

extension Checks {
    /// Linear setup with a team and no project: the team is enough to go on, and Forge works on the team's cards.
    static func linearTeamChecks(_ check: (String, Bool) -> Void) {
        var c = SetupChoices()
        c.linearUser = "Sam"
        check("with no team picked, setup stays on the project screen", c.nextScreen == 1)
        (c.teamID, c.teamName, c.columnsReady) = ("team-adc", "ADC Rewrite", true)
        check("a Linear team with no project moves on past the project screen", c.nextScreen == 2)
        check("a team with no project is a board of its own", SetupStore.projectID(c) != nil)
        check("Continue works with only a team picked", ProjectScreen.canContinue(team: "team-adc", existing: Pipeline.names))
        check("no team, no Continue", !ProjectScreen.canContinue(team: "", existing: Pipeline.names))
        check("a team missing columns still can't continue", !ProjectScreen.canContinue(team: "team-adc", existing: ["Todo"]))
        let card = LinearAPI.issueInput(team: "team-adc", project: nil, state: "s1", title: "t", description: "d")
        check("a card made with no project lands in the team", card["teamId"] as? String == "team-adc" && card["projectId"] == nil)
        check(
            "a card made with a project still lands in it",
            LinearAPI.issueInput(team: "t", project: "p1", state: "s", title: "t", description: "d")["projectId"] as? String == "p1")
        let fm = EngineSettings.frontMatter(c, cardsFolder: "/c")
        check(
            "with no project, the engine reads the whole team's cards",
            fm.contains("  kind: linear\n  project_slug: \"\"\n  team_id: \"team-adc\"\n"))
        (c.repo, c.worker) = ("acme/app", .claude)
        var unfinished = false
        do { _ = try EngineSettings.workflowText(c) } catch { unfinished = "\(error)" == "Setup isn't finished yet." }
        check("a team with no project still gets its workflow file", !unfinished)
        (c.projectID, c.projectSlug, c.projectName) = ("p1", "adc-api", "API")
        let picked = EngineSettings.frontMatter(c, cardsFolder: "/c")
        check(
            "a picked project still narrows the cards to that project",
            picked.contains("  kind: linear\n  project_slug: \"adc-api\"\n") && !picked.contains("team_id"))
    }
}
