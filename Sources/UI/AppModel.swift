import AppKit
import SwiftUI

/// The app's one model: setup answers, which screen shows, and the board's live state.
@MainActor
final class AppModel: ObservableObject {
    @Published var choices: SetupChoices
    @Published var screen: Int
    /// The live board, pushed by the engine.
    @Published var engine: EngineState?
    @Published var engineProblem: String?

    /// Render mode: views draw sample data and never touch Linear, GitHub or the Keychain.
    let preview: Bool
    var sample = Sample()
    /// The board's link to the engine.
    lazy var link = BoardLink(model: self)
    /// Setup was changed since the engine started, so the board restarts it with the new answers.
    var settingsChanged = false

    /// What render mode shows instead of the person's real Linear and GitHub.
    struct Sample {
        var teams = [LinearAPI.Team(id: "t1", name: "Engineering", key: "ENG", triageEnabled: false)]
        var projects = [LinearAPI.Project(id: "p1", name: "Forge Desktop test", slugId: "forge-desktop-test")]
        var states = ["Backlog", "Todo", "In Progress", "Done", "Canceled"]
        var githubUser: GitHub.User? = GitHub.User(login: "samrivera", name: "Sam Rivera", id: 1234567)
        var gpgKeys = [GitHub.GPGKey(id: "SAMPLEKEY", name: "Sam Rivera", email: "sam@example.com")]
        var workpad = """
            ## Forge Workpad

            ### Plan
            - [x] Reproduce: the login page accepts an empty password
            - [x] Add the check and its error message
            - [ ] Tests for both cases

            ### Notes
            Two helpers are writing the tests while the lead updates the docs.
            """
        var report = RepoReader.Report(
            summary: [
                "A small Node app with a web page and a test folder.",
                "Tests run with npm test, and CI runs them on every pull request.",
                "There's no formatter, linter or agent guide yet.",
            ],
            has: ["Tests in test/", "CI on pull requests"],
            missing: ["Formatter and linter", "AGENTS.md", "Pre-commit hook"],
            risks: ["Nothing stops a very large file or a hard-coded key"],
            guardrails: [
                .init(
                    id: "formatter-linter", title: "Formatter and linter", why: "Keeps every change in one style and catches common mistakes.",
                    recommended: true),
                .init(id: "agents-md", title: "Agent guide (AGENTS.md)", why: "Agents learn how to build, test and run the app.", recommended: true),
                .init(id: "file-length", title: "File size limit", why: "Stops files growing too big to change safely.", recommended: true),
                .init(id: "no-secrets", title: "No keys in the code", why: "Blocks a commit that contains a key or password.", recommended: true),
                .init(id: "layer-rules", title: "Layer rules", why: "The page code can't reach into the server code.", recommended: false),
            ])
        var repos = [
            GitHub.Repo(fullName: "acme/forge-desktop-e2e", defaultBranch: "main", canPush: true),
            GitHub.Repo(fullName: "acme/website", defaultBranch: "main", canPush: true),
            GitHub.Repo(fullName: "someone/library", defaultBranch: "main", canPush: false),
        ]
    }

    init(preview: Bool = false, choices: SetupChoices? = nil, screen: Int? = nil) {
        self.preview = preview
        let c = choices ?? (preview ? SetupChoices() : SetupChoices.load())
        self.choices = c
        self.screen = screen ?? c.nextScreen
        if !preview { GitHub.account = c.githubLogin }
    }

    static let screenTitles = ["Linear", "Project", "GitHub", "Repo", "Agent", "Ready", "Board"]

    /// The board's screen number (the last one).
    static let boardScreen = 6

    func save() {
        if !preview { choices.save() }
        if screen < Self.boardScreen { settingsChanged = true }
    }

    func go(_ s: Int) {
        screen = max(0, min(Self.boardScreen, s))
    }

    func next() {
        save()
        go(screen + 1)
    }

    var linearKey: String? { preview ? "preview" : Keychain.get(.linearKey) }

    var linear: LinearAPI? { linearKey.map { LinearAPI(key: $0) } }

    func openLink(_ s: String) {
        if let u = URL(string: s) { NSWorkspace.shared.open(u) }
    }
}
