import Foundation

extension ScreenRender {
    /// Shots for screens added by later steps of the plan.
    static func extraShots(_ base: SetupChoices) -> [Shot] {
        var project = base
        project.teamID = "t1"
        project.teamName = "Engineering"
        project.projectID = "p1"
        project.projectName = "AI Trading Bot"
        project.projectSlug = "ai-trading-bot"
        project.columnsReady = true
        var github = project
        github.githubLogin = "samrivera"
        github.signing = .forgeKey
        var repo = github
        repo.repo = "acme/ai-trading-bot"
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
        var codex = repo
        codex.worker = .codex
        let board = AppModel.boardScreen
        return [
            Shot(name: "3-github", screen: 2, choices: project),
            Shot(name: "4-repo", screen: 3, choices: github),
            Shot(name: "5-agent", screen: 4, choices: repo),
            Shot(name: "5-agent-signed-out", screen: 4, choices: repo, scene: "signed-out"),
            Shot(name: "5-agent-sign-in", screen: 4, choices: repo, scene: "signed-out-guide"),
            Shot(name: "5-agent-sign-in-codex", screen: 4, choices: codex, scene: "signed-out-guide"),
            Shot(name: "6-ready", screen: 5, choices: done),
            Shot(name: "6-ready-report", screen: 5, choices: report),
            Shot(name: "6-ready-reading", screen: 5, choices: done, scene: "reading"),
            Shot(name: "7-orchestrator", screen: board, choices: ready, engine: SampleBoard.state),
            Shot(name: "7-orchestrator-empty", screen: board, choices: ready, engine: SampleBoard.empty),
            Shot(name: "7-orchestrator-few", screen: board, choices: ready, engine: SampleBoard.few),
            Shot(name: "7-orchestrator-reading", screen: board, choices: ready),
            Shot(name: "7-orchestrator-stopping", screen: board, choices: ready, engine: SampleBoard.stopping),
            Shot(name: "9-orchestrator-signed-out", screen: board, choices: ready, engine: SampleBoard.signedOut),
            Shot(name: "9-orchestrator-linear-limit", screen: board, choices: ready, engine: SampleBoard.problem),
            Shot(name: "10-workflow", screen: AppModel.workflowScreen, choices: ready, engine: SampleBoard.state),
            Shot(name: "10-workflow-qa-off", screen: AppModel.workflowScreen, choices: ready, scene: "qa-off"),
            Shot(name: "10-workflow-restarting", screen: AppModel.workflowScreen, choices: ready, engine: SampleBoard.state, scene: "restarting"),
            Shot(name: "11-settings", screen: AppModel.settingsScreen, choices: ready),
        ]
    }
}
