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
        return [
            Shot(name: "3-github", screen: 2, choices: project),
            Shot(name: "4-repo", screen: 3, choices: github),
            Shot(name: "5-agent", screen: 4, choices: repo),
        ]
    }
}
