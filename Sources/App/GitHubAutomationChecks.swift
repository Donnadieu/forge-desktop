import Foundation

extension Checks {
    /// A person turned off one of GitHub's project automations, saw the same warning, and thought Forge wasn't
    /// noticing (Nov 27 2026): GitHub's Workflows page lists about a dozen, the warning named some in one line, and
    /// nothing said which were still on. The step now lists exactly the ones Forge needs off, each marked on or off,
    /// names the ones that can stay on, and checks again on a button. The list below is a new project's default
    /// workflows as GitHub names them.
    static func githubAutomationChecks(_ check: (String, Bool) -> Void) {
        let defaults: [(String, Bool)] = [
            ("Auto-add sub-issues to project", true), ("Auto-add to project", false), ("Auto-archive items", false),
            ("Auto-close issue", true), ("Code changes requested", false), ("Code review approved", true),
            ("Item added to project", true), ("Item closed", true), ("Item reopened", false), ("Pull request linked to issue", false),
            ("Pull request merged", true),
        ]
        let flows = defaults.map { ["name": $0.0, "enabled": $0.1] as [String: Any] }
        let rows = GitHubProjectsAPI.automations(flows)
        check("every automation Forge needs off is listed, on or off", rows.map(\.name) == GitHubProjectsAPI.movingWorkflows)
        check("each says whether it's still on", rows.filter(\.on).map(\.name) == ["Item added to project", "Code review approved"])
        check("each says what it would do to a card", rows.allSatisfy { !$0.why.isEmpty })
        check("the ones that can stay on aren't in the list", !rows.contains { $0.name == "Item closed" || $0.name == "Auto-add to project" })
        check(
            "what still blocks Continue is exactly the ones still on",
            GitHubProjectsAPI.movers(flows) == ["Item added to project", "Code review approved"])
        check(
            "a duplicated workflow that's on counts even when the first copy is off",
            GitHubProjectsAPI.automations([
                ["name": "Item reopened", "enabled": false], ["name": "Item reopened", "enabled": true],
            ]).first { $0.name == "Item reopened" }?.on == true)
        check(
            "all off means nothing left to do",
            GitHubProjectsAPI.automations(defaults.map { ["name": $0.0, "enabled": false] as [String: Any] }).allSatisfy { !$0.on })
        let url = "https://github.com/users/marin/projects/1"
        check("the button opens the project's Workflows page", GitHubProjectScreen.workflowsURL(url) == url + "/workflows")
        check("there's a way to check again now", GitHubProjectScreen.checkAgainTitle == "Check again")
        check("the steps say how to turn one off", GitHubProjectScreen.automationSteps.contains("Off"))
        check(
            "the ones that stay on are named, so nobody turns off a dozen",
            ["Item closed", "Pull request merged", "Auto-add to project"].allSatisfy { GitHubProjectScreen.stayOnLine.contains($0) })
        check(
            "the title counts what's left",
            GitHubProjectScreen.automationsTitle(on: 2) == "Turn off 2 of GitHub's automations in this project"
                && GitHubProjectScreen.automationsTitle(on: 1) == "Turn off 1 of GitHub's automations in this project")
    }
}
