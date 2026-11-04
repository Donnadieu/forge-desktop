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
    /// Why the last card move from the board didn't happen; cleared by the next move.
    @Published var moveProblem: String?

    /// Render mode: views draw sample data and never touch Linear, GitHub or the Keychain.
    let preview: Bool
    var sample = Sample()
    /// The board's link to the engine.
    lazy var link = BoardLink(model: self)
    /// Setup was changed since the engine started, so the board restarts it with the new answers.
    var settingsChanged = false

    /// What render mode shows instead of the person's real Linear and GitHub.
    struct Sample {
        /// Which variant of a screen render mode draws (e.g. "signed-out").
        var scene: String?
        var teams = [LinearAPI.Team(id: "t1", name: "Engineering", key: "ENG", triageEnabled: false)]
        var projects = [LinearAPI.Project(id: "p1", name: "AI Trading Bot", slugId: "ai-trading-bot")]
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
            GitHub.Repo(fullName: "acme/ai-trading-bot", defaultBranch: "main", canPush: true),
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

    static let screenTitles = ["Linear", "Project", "GitHub", "Repo", "Agent", "Harness engineering", "Orchestrator"]

    /// The Orchestrator's screen number (the end of setup).
    static let boardScreen = 6
    /// Setup 6: harness engineering (getting the repo ready for agents).
    static let harnessScreen = 5
    /// The Workflow Studio screen (stages on and off, agents at once).
    static let workflowScreen = 7
    /// Settings: what Forge connects to; each Change opens that setup step.
    static let settingsScreen = 8

    /// Set when a setup step was opened from Settings: Continue and Back return there instead of walking on.
    @Published var returnTo: Int?
    /// The repo just changed from Settings: the harness step offers to get this repo ready for agents.
    @Published var harnessOffer: String?

    /// Setup has two modes. The first run walks the steps in order; opened from Settings (changing), every
    /// step is listed, done or not, and any of them opens with a click.
    var changing: Bool { returnTo != nil }

    /// The steps the left-hand list shows: the first run ends on the Orchestrator; changing lists only
    /// what can be changed.
    static func listedSteps(changing: Bool) -> [Int] { changing ? Array(0..<boardScreen) : Array(0...boardScreen) }

    /// Where Continue on the repo step goes when changing: a new repo goes to harness engineering to offer
    /// getting it ready for agents; anything else goes back to Settings (nil = the usual next).
    static func afterRepo(changing: Bool, old: String?, new: String) -> Int? {
        changing && old != new ? harnessScreen : nil
    }

    /// `restarts: false` for answers the engine doesn't read (harness engineering), so it isn't restarted.
    func save(restarts: Bool = true) {
        if !preview { choices.save() }
        if restarts, screen < Self.boardScreen || screen == Self.workflowScreen { settingsChanged = true }
    }

    /// Brings the current repo's harness record up to date from GitHub (not in screen renders).
    func refreshHarness() async {
        guard !preview, let repo = choices.repo else { return }
        let before = choices.harness?[repo]
        guard let r = await HarnessCheck.refresh(repo: repo, record: before), r != before, choices.repo == repo else { return }
        choices.setHarness(r, for: repo)
        choices.save()
    }

    func go(_ s: Int) {
        screen = max(0, min(Self.settingsScreen, s))
        if screen >= Self.boardScreen { returnTo = nil }
        if screen != Self.harnessScreen { harnessOffer = nil }
    }

    /// Opens one setup step from Settings.
    func change(_ step: Int) {
        go(step)
        returnTo = Self.settingsScreen
    }

    func next(restarts: Bool = true) {
        save(restarts: restarts)
        go(returnTo ?? screen + 1)
    }

    var linearKey: String? { preview ? "preview" : Keychain.get(.linearKey) }

    var linear: LinearAPI? { linearKey.map { LinearAPI(key: $0) } }

    /// The project's page in Linear (the workspace's address when Forge knows it).
    var projectURL: String {
        let key = choices.linearURLKey ?? engine?.cards.first?.url.flatMap { URL(string: $0)?.pathComponents.dropFirst().first }
        guard let key else { return "https://linear.app" }
        return "https://linear.app/\(key)" + (choices.projectSlug.map { "/project/\($0)" } ?? "")
    }

    func openLink(_ s: String) {
        if let u = URL(string: s) { NSWorkspace.shared.open(u) }
    }
}
