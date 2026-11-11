import Foundation

extension Checks {
    /// Setup asks for the workspace's name (on the repo screen), suggests one, and saves what was typed.
    @MainActor
    static func workspaceNameChecks(_ check: (String, Bool) -> Void) {
        var c = SetupChoices()
        (c.teamID, c.teamName, c.projectName) = ("team-adc", "ADC Rewrite", "ADC Rewrite")
        check(
            "the name suggested is the repo's, once one is picked",
            RepoScreen.suggestedName(current: "My workspace", repo: "acme/adc-web", choices: c) == "adc-web")
        check(
            "before a repo is picked, the team's name is suggested",
            RepoScreen.suggestedName(current: "My workspace", repo: nil, choices: c) == "ADC Rewrite")
        check(
            "with nothing known, the suggestion is My workspace",
            RepoScreen.suggestedName(current: nil, repo: nil, choices: SetupChoices()) == "My workspace")
        check(
            "a workspace that already has its own name keeps it",
            RepoScreen.suggestedName(current: "Client work", repo: "acme/adc-web", choices: c) == "Client work")

        let model = AppModel(preview: true)
        let repo = GitHub.Repo(fullName: "acme/adc-web", defaultBranch: "main", canPush: true)
        RepoScreen.apply(repo: repo, name: "  ADC Rewrite  ", to: model)
        check("setup saves the typed name as the workspace's", model.workspace?.name == "ADC Rewrite")
        check("and the repo as before", model.choices.repo == "acme/adc-web" && model.choices.repoChecked)
        let named = model.workspace?.name
        RepoScreen.apply(repo: repo, name: "   ", to: model)
        check("an empty name leaves the workspace's name alone", model.workspace?.name == named)
    }
}
