import SwiftUI

/// GitHub's device sign-in for a GitHub Issues board: Forge asks GitHub for a code, opens github.com/login/device,
/// and waits. The person only types the code and approves; Forge then reads who they are and keeps the sign-in.
@MainActor
final class GitHubBoardSignIn: ObservableObject {
    @Published var code: GitHubLogin.DeviceCode?
    @Published var waiting = false
    @Published var problem: String?
    private var task: Task<Void, Never>?

    func start(preview: Bool, openLink: @escaping (String) -> Void, done: @escaping (GitHubBoard) -> Void) {
        task?.cancel()
        problem = nil
        waiting = true
        if preview {
            code = Self.sampleCode
            return
        }
        task = Task {
            defer {
                waiting = false
                code = nil
            }
            do {
                let c = try await GitHubLogin.start()
                code = c
                openLink(c.verificationURL)
                let tokens = try await GitHubLogin.finish(c)
                guard tokens.canUseProjects else {
                    problem = "GitHub didn't grant the projects permission. Sign in again and approve it."
                    return
                }
                let me = try await GitHubProjectsAPI().viewer()
                done(GitHubBoard(login: me.login, name: me.name))
            } catch is CancellationError {
                return
            } catch {
                problem = "\(error)"
            }
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
        waiting = false
        code = nil
    }

    static let sampleCode = GitHubLogin.DeviceCode(
        deviceCode: "", userCode: "4F2A-9KQD", verificationURL: "https://github.com/login/device", interval: 5,
        expiresAt: Date().addingTimeInterval(900))
}

/// The GitHub half of setup 1: what will happen, then the code while Forge waits for the approval.
struct GitHubBoardSignInPanel: View {
    @ObservedObject var signIn: GitHubBoardSignIn
    let openLink: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let code = signIn.code {
                Text("Enter this code on GitHub").font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
                Text(code.userCode).font(Theme.mono(28, .medium)).foregroundStyle(Theme.heatBright).textSelection(.enabled)
                HStack(spacing: 10) {
                    Spinner(heat: true)
                    Text("Waiting for you to approve it in your browser…").font(Theme.sans(13)).foregroundStyle(Theme.textSec)
                }
                HStack(spacing: 16) {
                    Button("Open the page again") { openLink(code.verificationURL) }.buttonStyle(ForgeButton(kind: .plain))
                    Button("Cancel") { signIn.cancel() }.buttonStyle(ForgeButton(kind: .plain))
                }
                .padding(.top, 4)
            } else {
                Text("Sign in with your browser").font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
                Text(
                    "Forge opens GitHub and shows a short code. Enter it there and approve; Forge can then read your "
                        + "project, move its issues between columns, assign itself the ones it works on and comment on them."
                )
                .font(Theme.sans(13)).foregroundStyle(Theme.textSec).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Image(systemName: "lock").font(.system(size: 10))
                    Text("No password here. The sign-in is kept in your Mac's Keychain and nowhere else.")
                }
                .font(Theme.sans(11)).foregroundStyle(Theme.textMuted).padding(.top, 4)
            }
        }
        .padding(20)
        .frame(maxWidth: 640, alignment: .leading)
        .panel()
    }
}

/// Setup 2 on GitHub Issues: pick the project and the repo new issues go to, see the pipeline one line per
/// column, and add the Status options the project is missing (only after a yes, since everyone sees them).
struct GitHubProjectScreen: View {
    @ObservedObject var model: AppModel
    @State var projects: [GitHubProjectsAPI.Project] = []
    @State private var projectID = ""
    @State private var detail: GitHubProjectsAPI.ProjectDetail?
    @State private var repo = ""
    @State private var mine: [String] = []
    @State private var busy = false
    @State private var problem: String?
    @State private var asking = false
    @State private var notes: [String] = []

    private var project: GitHubProjectsAPI.Project? { projects.first { $0.id == projectID } }
    private var existing: [String] { detail?.status?.options.map(\.name) ?? [] }
    private var missing: [Column] { Pipeline.missing(existing: existing) }
    /// The project's linked repos first, then the person's own.
    private var repos: [String] {
        let linked = detail?.repos ?? []
        return linked + mine.filter { !linked.contains($0) }
    }
    private var movers: [String] { detail?.movers ?? [] }
    private var ready: Bool { detail?.status != nil && missing.isEmpty && movers.isEmpty && !repo.isEmpty }

    var body: some View {
        SetupFrame(
            model: model,
            question: "Which project should Forge work on?",
            detail: "Pick the GitHub project whose Status field holds the columns, and the repo new issues go to. "
                + "Every card moves through these columns:",
            primary: "Continue",
            primaryEnabled: ready,
            busy: busy,
            action: finish
        ) {
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
            .font(Theme.sans(13))
            .foregroundStyle(Theme.textSec)
            .padding(.bottom, 18)
            ColumnList(existing: existing, showMarks: detail != nil, where: "GitHub")
            if detail?.status != nil && !missing.isEmpty {
                HStack(spacing: 12) {
                    Text("\(missing.count) column\(missing.count == 1 ? " is" : "s are") missing from this project's Status.")
                        .font(Theme.sans(13))
                        .foregroundStyle(Theme.heatBright)
                    Button("Add them to GitHub…") { asking = true }
                        .buttonStyle(ForgeButton(kind: .fix))
                }
                .padding(.top, 14)
            }
            if !movers.isEmpty, let url = project?.url {
                ProblemLine(
                    text: "GitHub moves cards on its own in this project (\(movers.joined(separator: ", "))). "
                        + "Turn \(movers.count == 1 ? "it" : "them") off so cards stay where Forge puts them; Forge checks again by itself.")
                Button("Turn them off on GitHub ↗") { model.openLink(url + "/workflows") }
                    .buttonStyle(ForgeButton(kind: .fix))
                    .padding(.top, 6)
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
                if let d = try? await GitHubProjectsAPI().project(projectID) { detail = d }
            }
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

    private func loadProjects() async {
        if model.preview {
            projects = model.sample.githubProjects
            projectID = projects.first?.id ?? ""
            detail = model.sample.githubProject
            if model.sample.scene == "github-movers" { detail?.movers = ["Item added to project", "Pull request linked to issue"] }
            repo = detail?.repos.first ?? ""
            return
        }
        busy = true
        defer { busy = false }
        do {
            projects = try await GitHubProjectsAPI().projects().sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
            mine = try await GitHubProjectsAPI().repos()
            if let id = model.choices.githubBoard?.projectID, projects.contains(where: { $0.id == id }) {
                projectID = id
            } else if projects.count == 1 {
                projectID = projects[0].id
            }
        } catch { problem = "\(error)" }
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
        model.next()
    }
}
