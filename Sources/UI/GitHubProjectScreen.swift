import SwiftUI

/// Setup 2 on GitHub Issues: pick the project and the repo new issues go to, see the pipeline one line per
/// column, and add the Status options the project is missing (only after a yes, since everyone sees them).
/// The list never just sits empty: no project yet, an organization GitHub keeps closed, or a sign-in without
/// project access each say so, with the one thing that fixes it.
struct GitHubProjectScreen: View {
    @ObservedObject var model: AppModel
    @State var projects: [GitHubProjectsAPI.Project] = []
    /// Organizations whose projects GitHub didn't show this sign-in.
    @State private var hidden: [String] = []
    @State private var loaded = false
    /// Why the project list didn't load (the list's own problem; `problem` is for the rest of the screen).
    @State private var listProblem: String?
    @State private var needsReconnect = false
    @StateObject private var signIn = GitHubBoardSignIn()
    @State private var projectID = ""
    @State private var detail: GitHubProjectsAPI.ProjectDetail?
    @State private var repo = ""
    @State private var mine: [String] = []
    @State private var busy = false
    @State private var problem: String?
    @State private var asking = false
    @State private var notes: [String] = []
    @State private var checking = false
    @State private var checkedAt: Date?

    private var project: GitHubProjectsAPI.Project? { projects.first { $0.id == projectID } }
    private var existing: [String] { detail?.status?.options.map(\.name) ?? [] }
    private var missing: [Column] { Pipeline.missing(existing: existing) }
    /// The project's linked repos first, then the person's own.
    private var repos: [String] {
        let linked = detail?.repos ?? []
        return linked + mine.filter { !linked.contains($0) }
    }
    private var movers: [String] { detail?.movers ?? [] }
    private var ready: Bool { Self.canContinue(hasStatus: detail?.status != nil, existing: existing, movers: movers, repo: repo) }
    private var state: ListState { Self.listState(loaded: loaded, count: projects.count, problem: listProblem, reconnect: needsReconnect) }
    private var login: String { model.choices.githubBoard?.login ?? "" }

    static func canContinue(hasStatus: Bool, existing: [String], movers: [String], repo: String) -> Bool {
        hasStatus && Pipeline.missingRequired(existing: existing).isEmpty && movers.isEmpty && !repo.isEmpty
    }

    /// What the project list shows: still looking, the picker, no project yet, a sign-in to redo, or why it failed.
    enum ListState: Equatable {
        case loading, pick, empty
        case reconnect(String)
        case failed(String)
    }

    static func listState(loaded: Bool, count: Int, problem: String?, reconnect: Bool) -> ListState {
        if let problem { return reconnect ? .reconnect(problem) : .failed(problem) }
        if !loaded { return .loading }
        return count == 0 ? .empty : .pick
    }

    /// The person's projects on GitHub, where its New project button is.
    static func newProjectURL(login: String) -> String { "https://github.com/\(login)?tab=projects" }

    static let reconnectTitle = "Reconnect GitHub with project access"
    /// GitHub's Workflows page for the project. Each workflow's own page has an id GitHub's API doesn't give.
    static func workflowsURL(_ project: String) -> String { project + "/workflows" }
    static let checkAgainTitle = "Check again"
    static let automationSteps =
        "On GitHub's Workflows page, click each one marked On below, then switch it Off at the top right. Forge checks again every few seconds."
    static let stayOnLine =
        "The rest of that page can stay as it is: Item closed, Pull request merged, Auto-add to project, Auto-archive items, Auto-close issue "
        + "and Auto-add sub-issues to project don't move cards against Forge."
    static func automationsTitle(on: Int) -> String { "Turn off \(on) of GitHub's automations in this project" }

    /// Forge signs in through GitHub CLI's app, so that's the app an organization owner has to approve.
    static func hiddenLine(_ orgs: [String]) -> String {
        let names = orgs.count < 3 ? orgs.joined(separator: " and ") : orgs.dropLast().joined(separator: ", ") + " and " + orgs.last!
        return "GitHub didn't show \(names)'s projects: \(orgs.count == 1 ? "it only lets" : "they only let") approved apps read them. "
            + "Forge signs in as GitHub CLI; ask an owner to approve it, then check again."
    }

    var body: some View {
        SetupFrame(
            model: model,
            question: "Which project should Forge work on?",
            detail: "Pick the GitHub project whose Status field holds the columns, and the repo new issues go to. "
                + "Every card moves through these columns:",
            primary: "Continue",
            primaryEnabled: ready,
            busy: busy || signIn.waiting,
            action: finish
        ) {
            list.padding(.bottom, 18)
            ColumnList(existing: existing, showMarks: detail != nil, where: "GitHub")
            if detail?.status != nil {
                MissingColumnsNote(existing: existing, from: "this project's Status", tracker: "GitHub") { asking = true }
            }
            if !movers.isEmpty, let url = project?.url, let rows = detail?.automations {
                AutomationsPanel(rows: rows, checking: checking, checkedAt: checkedAt) {
                    model.openLink(Self.workflowsURL(url))
                } check: {
                    Task { await recheck() }
                }
                .padding(.top, 12)
            }
            if detail != nil && detail?.status == nil {
                ProblemLine(text: "This project has no Status field. Add a single-select field named Status on GitHub, then pick it again.")
            }
            ForEach(notes, id: \.self) { GoodLine(text: $0).padding(.top, 6) }
            ProblemLine(text: problem)
        }
        .task { await loadProjects() }
        .task(id: movers) {
            // Re-check every few seconds while GitHub's automations are on, so the fix shows by itself.
            while !movers.isEmpty, !model.preview, !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                if !Task.isCancelled { await recheck() }
            }
        }
        // Back from GitHub (a new project, an approved app): look again by itself.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            if !model.preview, !busy, !needsReconnect, state != .pick || !hidden.isEmpty { Task { await loadProjects() } }
            if !model.preview, !movers.isEmpty { Task { await recheck() } }
        }
        .onChange(of: projectID) { _, _ in Task { await loadDetail() } }
        .confirmationDialog(
            "Add \(missing.count) column\(missing.count == 1 ? "" : "s") to \(project?.title ?? "this project") on GitHub?", isPresented: $asking
        ) {
            Button("Add \(missing.map(\.name).joined(separator: ", "))") { Task { await createMissing() } }
            Button("Not now", role: .cancel) {}
        } message: {
            Text("This adds options to the project's Status field: everyone who sees the project will see the new columns. Cards keep theirs.")
        }
    }

    @ViewBuilder private var list: some View {
        switch state {
        case .loading:
            HStack(spacing: 10) {
                Spinner()
                Text("Looking for your GitHub projects…").font(Theme.sans(.body)).foregroundStyle(Theme.textSec)
            }
        case .pick:
            HStack(spacing: 24) {
                Picker("Project", selection: $projectID) {
                    if projectID.isEmpty { Text("Choose…").tag("") }
                    ForEach(projects) { Text("\($0.title) · \($0.owner)").tag($0.id) }
                }
                .fixedSize()
                if detail != nil {
                    Picker("New issues go to", selection: $repo) {
                        if repo.isEmpty { Text("Choose…").tag("") }
                        ForEach(repos, id: \.self) { Text($0).tag($0) }
                    }
                    .fixedSize()
                }
            }
            .font(Theme.sans(.body))
            .foregroundStyle(Theme.textSec)
            hiddenNote
        case .empty:
            Notice(
                title: hidden.isEmpty ? "Your GitHub account has no projects yet." : "Forge found no GitHub project it can use.",
                detail: "Forge's board is a GitHub project: its Status field holds the columns. Make one on GitHub "
                    + "(the Board layout), then come back here; Forge looks again by itself."
            ) {
                HStack(spacing: 16) {
                    Button("Create a project on GitHub ↗") { model.openLink(Self.newProjectURL(login: login)) }
                        .buttonStyle(ForgeButton(kind: .fix))
                    Button("Check again") { Task { await loadProjects() } }.buttonStyle(ForgeButton(kind: .plain))
                }
            }
            hiddenNote
        case .reconnect(let text):
            Notice(title: text, detail: "Sign in to GitHub again and approve project access; Forge then lists your projects.") {
                if signIn.code != nil {
                    GitHubBoardSignInPanel(signIn: signIn, openLink: model.openLink)
                } else {
                    Button(Self.reconnectTitle) { reconnect() }.buttonStyle(ForgeButton(kind: .fix))
                }
            }
            ProblemLine(text: signIn.problem)
        case .failed(let text):
            Notice(title: "Forge couldn't load your GitHub projects.", detail: text) {
                Button("Try again") { Task { await loadProjects() } }.buttonStyle(ForgeButton(kind: .fix))
            }
        }
    }

    @ViewBuilder private var hiddenNote: some View {
        if !hidden.isEmpty {
            Notice(title: Self.hiddenLine(hidden), icon: "lock") {
                Button("Ask for access on GitHub ↗") {
                    model.openLink("https://github.com/settings/connections/applications/\(GitHubLogin.clientID)")
                }
                .buttonStyle(ForgeButton(kind: .plain))
            }
            .padding(.top, 12)
        }
    }

    private func loadProjects() async {
        if model.preview { return loadSample() }
        busy = true
        defer { busy = false }
        do {
            let found = try await GitHubProjectsAPI().projects()
            projects = found.projects.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
            hidden = found.hidden
            (listProblem, needsReconnect) = (nil, false)
            if let id = model.choices.githubBoard?.projectID, projects.contains(where: { $0.id == id }) {
                projectID = id
            } else if projects.count == 1 {
                projectID = projects[0].id
            }
        } catch {
            listProblem = "\(error)"
            needsReconnect = (error as? GitHubProjectsAPI.Failure)?.signedOut == true
        }
        loaded = true
        if mine.isEmpty, !needsReconnect { mine = (try? await GitHubProjectsAPI().repos()) ?? [] }
    }

    private func loadSample() {
        loaded = true
        switch model.sample.scene {
        case "github-no-projects":
            projects = []
        case "github-hidden-org":
            (projects, hidden) = ([], ["acme-corp"])
        case "github-reconnect":
            (listProblem, needsReconnect) = (GitHubProjectsAPI.missingProjectAccess, true)
        default:
            projects = model.sample.githubProjects
            projectID = projects.first?.id ?? ""
            detail = model.sample.githubProject
            if model.sample.scene == "github-movers" { detail?.movers = ["Item added to project", "Pull request linked to issue"] }
            repo = detail?.repos.first ?? ""
        }
    }

    /// Signs the connection in use in again, right here, then lists the projects.
    private func reconnect() {
        let current = model.store.connections(.github).first { $0.id == model.choices.connection }
        signIn.start(preview: model.preview, item: current?.item, openLink: model.openLink) { board in
            if var t = current {
                (t.login, t.user, t.org) = (board.login, board.name ?? board.login, "@\(board.login)")
                model.keep(connection: t)
                t.apply(to: &model.choices)
            }
            Task { await loadProjects() }
        }
    }

    private func loadDetail() async {
        if model.preview { return }
        detail = nil
        guard !projectID.isEmpty else { return }
        busy = true
        defer { busy = false }
        do {
            let d = try await GitHubProjectsAPI().project(projectID)
            detail = d
            let saved = model.choices.githubBoard?.issueRepo
            repo = [saved, d.repos.first, model.choices.repo].compactMap { $0 }.first { repos.contains($0) } ?? ""
        } catch { problem = "\(error)" }
    }

    /// Reads the project's automations again, keeping the rest of the screen as it is.
    private func recheck() async {
        guard !model.preview, !projectID.isEmpty, !checking else { return }
        checking = true
        defer { checking = false }
        do {
            detail = try await GitHubProjectsAPI().project(projectID)
            checkedAt = Date()
            problem = nil
        } catch { problem = "Forge couldn't check the project again: \(error)" }
    }

    private func createMissing() async {
        guard let field = detail?.status else { return }
        busy = true
        defer { busy = false }
        do {
            try await GitHubProjectsAPI().createMissing(field: field, missing)
            detail = try await GitHubProjectsAPI().project(projectID)
            notes = ["The columns are ready."]
        } catch { problem = "\(error)" }
    }

    private func finish() {
        guard let p = project, let d = detail, let status = d.status, d.movers.isEmpty, var g = model.choices.githubBoard else { return }
        if !model.preview, !d.repos.contains(repo) {
            // New issues land in this repo, so its issues should show on the project.
            Task { try? await GitHubProjectsAPI().link(project: p.id, repo: repo) }
        }
        (g.projectID, g.projectTitle, g.projectURL) = (p.id, p.title, p.url)
        (g.statusFieldID, g.columns, g.issueRepo) = (status.id, GitHubProjectsAPI.columnMap(status.options), repo)
        model.choices.githubBoard = g
        (model.choices.projectID, model.choices.projectName, model.choices.projectSlug) = (p.id, p.title, p.id)
        model.choices.columnsReady = true
        model.choices.boardColumns = existing
        model.next()
    }
}
