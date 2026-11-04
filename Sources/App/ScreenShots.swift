import Foundation

extension ScreenRender {
    /// Shots for screens added by later steps of the plan.
    static func extraShots(_ base: SetupChoices) -> [Shot] {
        var project = base
        project.teamID = "t1"
        project.teamName = "Engineering"
        project.projectID = "p1"
        project.projectName = "Forge Desktop test"
        project.projectSlug = "forge-desktop-test"
        project.columnsReady = true
        var github = project
        github.githubLogin = "samrivera"
        github.signing = .forgeKey
        var repo = github
        repo.repo = "acme/forge-desktop-e2e"
        repo.defaultBranch = "main"
        repo.repoChecked = true
        var done = repo
        done.worker = .claude
        done.model = "claude-sonnet-5"
        done.workerChecked = true
        var report = done
        report.repoReadyCard = "show-report"
        var ready = done
        ready.repoReady = true
        return [
            Shot(name: "3-github", screen: 2, choices: project),
            Shot(name: "4-repo", screen: 3, choices: github),
            Shot(name: "5-agent", screen: 4, choices: repo),
            Shot(name: "5-agent-signed-out", screen: 4, choices: repo, scene: "signed-out"),
            Shot(name: "5-agent-sign-in", screen: 4, choices: repo, scene: "signed-out-guide"),
            Shot(name: "6-ready", screen: 5, choices: done),
            Shot(name: "6-ready-report", screen: 5, choices: report),
            Shot(name: "6-ready-reading", screen: 5, choices: done, scene: "reading"),
            Shot(name: "7-board", screen: AppModel.boardScreen, choices: ready, engine: SampleBoard.state),
            Shot(name: "7-board-problem", screen: AppModel.boardScreen, choices: ready, engine: SampleBoard.problem),
            Shot(name: "7-board-reading", screen: AppModel.boardScreen, choices: ready),
        ]
    }
}
