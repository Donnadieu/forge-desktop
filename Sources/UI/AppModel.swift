import AppKit
import SwiftUI

/// The app's one model: setup answers, which screen shows, and the board's live state.
@MainActor
final class AppModel: ObservableObject {
    @Published var choices: SetupChoices {
        didSet { useSignIns() }
    }
    /// Trackers, projects and the intelligence provider accounts (store.json); `choices` is the running project.
    @Published var store: SetupStore
    @Published var screen: Int
    /// The live board of the project on screen, pushed by its engine.
    @Published var engine: EngineState?
    @Published var engineProblem: String?
    /// Every project engine's live state and problem, by project (AppModel+Fleet.swift).
    @Published var states: [String: EngineState] = [:]
    @Published var problems: [String: String] = [:]
    /// Why the last card move from the board didn't happen; cleared by the next move.
    @Published var moveProblem: String?
    /// The workspace sheet on screen (switch, new, rename, delete, run another project), over any screen.
    @Published var ask: WorkspaceAsk?

    /// Render mode: views draw sample data and never touch Linear, Basecamp, GitHub or the Keychain.
    let preview: Bool
    var sample = Sample()
    /// Each project's link to its engine (AppModel+Fleet.swift); `link` is the one on screen.
    var links: [String: BoardLink] = [:]
    /// Setup was changed since the engine started, so the board restarts it with the new answers.
    var settingsChanged = false

    /// What render mode shows instead of the person's real Linear and GitHub.
    struct Sample {
        /// Which variant of a screen render mode draws (e.g. "signed-out").
        var scene: String?
        var teams = [LinearAPI.Team(id: "t1", name: "Engineering", key: "ENG", triageEnabled: false)]
        var projects = [LinearAPI.Project(id: "p1", name: "AI Trading Bot", slugId: "ai-trading-bot")]
        var states = ["Backlog", "Todo", "In Progress", "Done", "Canceled"]
        /// The tracker setup 1 shows first (nil = the saved one).
        var tracker: Tracker?
        var basecampProjects = [
            BasecampAPI.Project(id: 101, name: "AI Trading Bot", dock: [.init(id: 201, name: "kanban_board", title: "Card Table", enabled: true)])
        ]
        var basecampTable: BasecampAPI.CardTable? = BasecampAPI.CardTable(
            id: 201, title: "Card Table",
            lists: ["Triage", "Todo", "In Progress", "Done"].enumerated().map { .init(id: 300 + $0.offset, title: $0.element, type: nil) })
        var githubProjects = [
            GitHubProjectsAPI.Project(id: "PVT_1", number: 1, title: "AI Trading Bot", url: "https://github.com/users/acme/projects/1", closed: false)
        ]
        var githubProject: GitHubProjectsAPI.ProjectDetail? = GitHubProjectsAPI.ProjectDetail(
            project: GitHubProjectsAPI.Project(
                id: "PVT_1", number: 1, title: "AI Trading Bot", url: "https://github.com/users/acme/projects/1", closed: false),
            status: GitHubProjectsAPI.StatusField(
                id: "PVTSSF_1", options: ["Todo", "In Progress", "Done"].enumerated().map { .init(id: "opt\($0.offset)", name: $0.element) }),
            repos: ["acme/ai-trading-bot"])
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
        var c = choices ?? (preview ? SetupChoices() : SetupChoices.load())
        self.store = preview ? Self.sampleStore(&c) : SetupStore.load(migrating: &c)
        self.choices = c
        self.screen = screen ?? c.nextScreen
        useSignIns(github: true)
    }

    static let screenTitles = ["Tracker", "Project", "GitHub", "Repo", "Intelligence provider", "Harness engineering", "Orchestrator"]

    /// The Orchestrator's screen number (the end of setup).
    static let boardScreen = 6
    /// Setup 6: harness engineering (getting the repo ready for agents).
    static let harnessScreen = 5
    /// The Workflow Studio screen (stages on and off, agents at once).
    static let workflowScreen = 7
    /// Settings: what Forge connects to; each Change opens that setup step.
    static let settingsScreen = 8
    /// The projects a workspace manages, ticked under each tracker connection.
    static let projectsScreen = 9
    /// Every running workspace's cards in one Orchestrator.
    static let allWorkspacesScreen = 10

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
        // Moved to a project Forge already knows: its repo and account come back. Then the store records it.
        store.adopt(into: &choices)
        store.sync(choices)
        if !preview {
            choices.save()
            store.save()
        }
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
        screen = max(0, min(Self.allWorkspacesScreen, s))
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

    /// The running project's Linear connection's key.
    var linearKey: String? { preview ? "preview" : Keychain.get(named: store.trackerItem(choices)) }

    var linear: LinearAPI? { linearKey.map { LinearAPI(key: $0) } }

    /// Basecamp's API for the signed-in account.
    var basecampAPI: BasecampAPI? { choices.basecamp.map { BasecampAPI(accountID: $0.accountID) } }

    /// Makes a card in the board's Todo column (Linear, Basecamp or GitHub Issues): its identifier and link.
    func makeCard(title: String, description: String) async throws -> (identifier: String, url: String) {
        switch choices.board {
        case .linear:
            guard let api = linear, let team = choices.teamID, let project = choices.projectID else {
                throw BasecampLogin.Failure(description: "Forge lost track of your Linear project. Go back to the Project screen.")
            }
            let card = try await api.createIssue(team: team, project: project, column: "Todo", title: title, description: description)
            return (card.identifier, card.url)
        case .basecamp:
            guard let api = basecampAPI, let b = choices.basecamp, let p = b.projectID.flatMap(Int.init),
                let todo = b.columns?["Todo"].flatMap(Int.init)
            else {
                throw BasecampLogin.Failure(description: "Forge lost track of your Basecamp project. Go back to the Project screen.")
            }
            let card = try await api.createCard(project: p, column: todo, title: title, content: BasecampAPI.html(description))
            return ("BC-\(card.id)", card.app_url ?? b.url)
        case .github:
            guard let g = choices.githubBoard, let project = g.projectID, let field = g.statusFieldID, let todo = g.columns?["Todo"],
                let repo = g.issueRepo
            else {
                throw BasecampLogin.Failure(description: "Forge lost track of your GitHub project. Go back to the Project screen.")
            }
            let issue = try await GitHubProjectsAPI().createIssue(
                repo: repo, project: project, field: field, option: todo, title: title, body: description)
            return ("\(repo.split(separator: "/").last ?? "")#\(issue.number)", issue.url)
        }
    }

    /// The project's page in Linear, Basecamp or GitHub (the workspace's address when Forge knows it).
    var projectURL: String {
        if choices.board == .basecamp { return choices.basecamp?.url ?? "https://launchpad.37signals.com" }
        if choices.board == .github { return choices.githubBoard?.url ?? "https://github.com" }
        let key = choices.linearURLKey ?? engine?.cards.first?.url.flatMap { URL(string: $0)?.pathComponents.dropFirst().first }
        guard let key else { return "https://linear.app" }
        return "https://linear.app/\(key)" + (choices.projectSlug.map { "/project/\($0)" } ?? "")
    }

    /// The account the running project's intelligence provider uses.
    var account: AIAccount? { store.activeAccount(choices) }

    /// Keeps a new or changed account (saved at once, so a sign-in is never lost).
    func keep(_ a: AIAccount) {
        store.put(a)
        if !preview { store.save() }
    }

    /// Forgets a cleared account; the running project then needs another one before it starts again.
    func forget(_ a: AIAccount) {
        store.remove(a.id)
        if account?.id == a.id {
            choices.accountID = nil
            choices.workerChecked = false
            settingsChanged = true
            if !preview { choices.save() }
        }
        if !preview { store.save() }
    }

    /// Render mode's accounts: two Claude Code sign-ins and a key, and one Codex sign-in.
    static func sampleStore(_ c: inout SetupChoices) -> SetupStore {
        var s = SetupStore()
        s.accounts = [
            AIAccount.new(.claude, method: .browser, name: "Personal", id: "sample-personal"),
            AIAccount.new(.claude, method: .browser, name: "ConstructEase", id: "sample-work"),
            AIAccount.new(.claude, method: .key, name: "Team API key", id: "sample-key"),
            AIAccount.new(.codex, method: .browser, name: "ChatGPT Pro", id: "sample-codex"),
        ]
        if c.accountID == nil, let w = c.worker { c.accountID = w.agent == .codex ? "sample-codex" : "sample-work" }
        s.sync(c)
        sampleWorkspaces(&s, c)
        return s
    }

    func openLink(_ s: String) {
        if let u = URL(string: s) { NSWorkspace.shared.open(u) }
    }
}
