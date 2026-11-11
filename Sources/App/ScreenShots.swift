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
        (github.authorName, github.authorEmail) = ("Sam Rivera", "1234567+samrivera@users.noreply.github.com")
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
            Shot(name: "4-repo-workspace-name", screen: 3, choices: github, scene: "unnamed-workspace"),
            Shot(name: "5-agent", screen: 4, choices: repo),
            Shot(name: "5-agent-signed-out", screen: 4, choices: repo, scene: "signed-out"),
            Shot(name: "5-agent-sign-in", screen: 4, choices: repo, scene: "signed-out-guide"),
            Shot(name: "5-agent-sign-in-codex", screen: 4, choices: codex, scene: "signed-out-guide"),
            Shot(name: "5-provider-accounts", screen: 4, choices: done, changing: true),
            Shot(name: "5-provider-add-account", screen: 4, choices: done, scene: "add-account", changing: true, height: 1000),
            Shot(name: "5-provider-clear-account", screen: 4, choices: done, scene: "clear-account", changing: true),
            Shot(name: "6-ready", screen: 5, choices: done),
            Shot(name: "6-ready-report", screen: 5, choices: report),
            Shot(name: "6-ready-reading", screen: 5, choices: done, scene: "reading"),
            Shot(name: "7-orchestrator", screen: board, choices: ready, engine: SampleBoard.state),
            Shot(name: "7-orchestrator-empty", screen: board, choices: ready, engine: SampleBoard.empty),
            Shot(name: "7-orchestrator-few", screen: board, choices: ready, engine: SampleBoard.few),
            Shot(name: "7-orchestrator-reading", screen: board, choices: ready),
            Shot(name: "7-orchestrator-stopping", screen: board, choices: ready, engine: SampleBoard.stopping),
            Shot(name: "7-orchestrator-stopped", screen: board, choices: ready, engine: SampleBoard.stopped),
            Shot(name: "9-orchestrator-stop-not-sent", screen: board, choices: ready, engine: SampleBoard.state, scene: "stop-not-sent"),
            Shot(name: "9-orchestrator-signed-out", screen: board, choices: ready, engine: SampleBoard.signedOut),
            Shot(name: "9-orchestrator-disk-full", screen: board, choices: ready, engine: SampleBoard.diskFull),
            Shot(name: "9-orchestrator-linear-limit", screen: board, choices: ready, engine: SampleBoard.problem),
            Shot(name: "9-orchestrator-late", screen: board, choices: ready, scene: "late"),
            Shot(name: "9-orchestrator-github-limit", screen: board, choices: ready, engine: SampleBoard.githubLimit),
            Shot(name: "9-orchestrator-usage-limit", screen: board, choices: ready, engine: SampleBoard.limited, height: 1250),
            Shot(
                name: "9-orchestrator-usage-limit-one-account", screen: board, choices: ready, engine: SampleBoard.limited, scene: "one-account",
                height: 1000),
            Shot(name: "12-orchestrator-moves", screen: board, choices: ready, engine: SampleBoard.moves, height: 1100),
            Shot(name: "14-sessions-new", screen: AppModel.sessionsScreen, choices: ready, scene: "sessions-new"),
            Shot(name: "14-sessions-chat", screen: AppModel.sessionsScreen, choices: ready, scene: "sessions-chat"),
            Shot(name: "14-sessions-card", screen: AppModel.sessionsScreen, choices: ready, scene: "sessions-card"),
            Shot(name: "14-sessions-side-by-side", screen: AppModel.sessionsScreen, choices: ready, scene: "sessions-split"),
            Shot(name: "14-sessions-review-comments", screen: AppModel.sessionsScreen, choices: ready, scene: "sessions-review"),
            Shot(name: "14-sessions-import", screen: AppModel.sessionsScreen, choices: ready, scene: "sessions-import"),
            Shot(name: "16-polish-code", screen: AppModel.sessionsScreen, choices: ready, scene: "sessions-code", height: 800, width: 1500),
            Shot(name: "16-polish-card-wide", screen: AppModel.sessionsScreen, choices: ready, scene: "sessions-card-long", height: 780, width: 1500),
            Shot(
                name: "16-polish-card-tall", screen: AppModel.sessionsScreen, choices: ready, scene: "sessions-card-long", height: 1300, width: 1500),
            Shot(
                name: "16-polish-card-narrow", screen: AppModel.sessionsScreen, choices: ready, scene: "sessions-card-long", height: 780, width: 1100),
            Shot(name: "12-orchestrator-merge-all", screen: board, choices: ready, engine: SampleBoard.moves, scene: "merge-all", height: 1100),
            Shot(name: "12-orchestrator-start-all", screen: board, choices: ready, engine: SampleBoard.moves, scene: "start-all", height: 1100),
            Shot(name: "10-workflow", screen: AppModel.workflowScreen, choices: ready, engine: SampleBoard.state),
            Shot(name: "10-workflow-qa-off", screen: AppModel.workflowScreen, choices: ready, scene: "qa-off"),
            Shot(name: "10-workflow-restarting", screen: AppModel.workflowScreen, choices: ready, engine: SampleBoard.state, scene: "restarting"),
            Shot(name: "10-workflow-roles", screen: AppModel.workflowScreen, choices: ready, scene: "roles", height: 1500),
            Shot(name: "10-workflow-moves-on", screen: AppModel.workflowScreen, choices: ready, scene: "moves-on"),
            Shot(name: "10-workflow-invisible-on", screen: AppModel.workflowScreen, choices: ready, scene: "invisible", height: 1500),
            Shot(name: "15-workflow-file", screen: AppModel.workflowFileScreen, choices: ready, height: 900),
            Shot(name: "15-workflow-file-problems", screen: AppModel.workflowFileScreen, choices: ready, scene: "file-problems", height: 900),
            Shot(name: "15-workflow-file-undo", screen: AppModel.workflowFileScreen, choices: ready, scene: "file-undo", height: 900),
            Shot(name: "11-settings", screen: AppModel.settingsScreen, choices: ready),
            Shot(name: "13-workspace-settings", screen: AppModel.settingsScreen, choices: ready, height: 1000),
            Shot(name: "13-trackers", screen: 0, choices: ready, changing: true),
            Shot(name: "13-projects", screen: AppModel.projectsScreen, choices: ready),
            Shot(name: "13-github-accounts", screen: 2, choices: ready, changing: true),
            Shot(name: "13-new-workspace", screen: AppModel.settingsScreen, choices: ready, scene: "ask-new"),
            Shot(name: "14-all-workspaces", screen: AppModel.allWorkspacesScreen, choices: ready, engine: SampleBoard.state, scene: "fleet"),
            Shot(name: "14-all-workspaces-none", screen: AppModel.allWorkspacesScreen, choices: ready),
            Shot(name: "13-run-project", screen: AppModel.settingsScreen, choices: ready, scene: "ask-run"),
        ] + changeShots(ready)
    }

    /// Settings with each harness state, and the setup timeline opened from Settings at every step.
    static func changeShots(_ ready: SetupChoices) -> [Shot] {
        let repo = ready.repo ?? ""
        func with(_ r: HarnessRecord) -> SetupChoices {
            var c = ready
            c.setHarness(r, for: repo)
            return c
        }
        let proposed = AppModel.Sample().report.guardrails
        let firstTwo = ["agents-md", "formatter-linter"]
        let partly = with(
            HarnessRecord(
                assessed: true, proposed: proposed, picked: firstTwo, applied: firstTwo, card: "ENG-42", cardURL: "https://linear.app", pr: 14,
                merged: true))
        let inCard = with(
            HarnessRecord(
                assessed: true, proposed: proposed, picked: ["file-length", "no-secrets"], applied: firstTwo, card: "ENG-57",
                cardURL: "https://linear.app", pr: 19, merged: false))
        let done = with(
            HarnessRecord(
                assessed: true, proposed: proposed, picked: ["file-length", "no-secrets"],
                applied: firstTwo + ["file-length", "no-secrets"], card: "ENG-57", cardURL: "https://linear.app", pr: 19, merged: true))
        let found = with(HarnessRecord(found: ["an agent guide (AGENTS.md)"]))
        var moved = ready
        moved.repo = "acme/website"
        let h = AppModel.harnessScreen
        return [
            Shot(name: "11-settings-partly", screen: AppModel.settingsScreen, choices: inCard),
            Shot(name: "11-settings-done", screen: AppModel.settingsScreen, choices: done),
            Shot(name: "12-change-1-linear", screen: 0, choices: partly, changing: true),
            Shot(name: "12-change-2-project", screen: 1, choices: partly, changing: true),
            Shot(name: "12-change-3-github", screen: 2, choices: partly, changing: true),
            Shot(name: "12-change-4-repo", screen: 3, choices: partly, changing: true),
            Shot(name: "12-change-5-agent", screen: 4, choices: partly, changing: true),
            Shot(name: "12-change-6-harness-not-done", screen: h, choices: ready, changing: true),
            Shot(name: "12-change-6-harness-found", screen: h, choices: found, changing: true),
            Shot(name: "12-change-6-harness-partly", screen: h, choices: partly, changing: true),
            Shot(name: "12-change-6-harness-in-card", screen: h, choices: inCard, changing: true),
            Shot(name: "12-change-6-harness-done", screen: h, choices: done, changing: true),
            Shot(name: "12-change-6-harness-reading", screen: h, choices: ready, scene: "reading", changing: true),
            Shot(name: "12-change-6-repo-changed-offer", screen: h, choices: moved, scene: "repo-offer", changing: true),
        ]
    }
}
