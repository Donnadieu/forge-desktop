import SwiftUI

/// One project a tracker connection holds, as the projects list shows it.
struct ProjectCandidate: Identifiable, Equatable {
    /// `<connection>:<slug>`, the id its record gets.
    let id: String
    let name: String
    let line: String
    let ref: ProjectRef
}

/// The projects a workspace manages: under each tracker connection it uses, every project there with a box to
/// tick. Projects another workspace manages are shown but can't be ticked here; the running one stays ticked.
struct ProjectsScreen: View {
    @ObservedObject var model: AppModel
    @State private var lists: [String: [ProjectCandidate]] = [:]
    @State private var problems: [String: String] = [:]
    @State private var picked: Set<String> = []
    @State private var extra: [String] = []
    @State private var find = ""

    private var running: String? { SetupStore.projectID(model.choices) }

    /// The connections this workspace uses, then any ticked here with "Use this tracker".
    private var used: [TrackerRecord] {
        let ids = (model.workspace?.connectionIDs ?? []) + extra
        var seen: [String] = []
        for id in ids where !seen.contains(id) { seen.append(id) }
        return seen.compactMap { model.store.connection($0) }
    }

    private var others: [TrackerRecord] { model.store.trackers.filter { t in !used.contains { $0.id == t.id } } }

    var body: some View {
        VStack(spacing: 0) {
            TopBar(suffix: "Settings")
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    PageHeader(
                        eyebrow: "\(model.workspace?.name ?? "Workspace") · Projects",
                        title: "Which projects should Forge manage?",
                        lead: "Pick any number under each tracker. Each project keeps its own repo and intelligence provider. "
                            + "One project runs at a time for now; Settings switches which one."
                    )
                    .padding(.bottom, -24)
                    TextField("", text: $find).forgeField(hint: "Find a project", empty: find.isEmpty, icon: "magnifyingglass")
                        .frame(maxWidth: 420)
                    ForEach(used, id: \.id) { t in block(t) }
                    ForEach(others, id: \.id) { t in
                        HStack {
                            SectionLabel(text: "\(t.kind.name) · \(t.title) · not in this workspace")
                            Spacer()
                            Button("Use this tracker") { extra.append(t.id) }.buttonStyle(ForgeButton(kind: .plain))
                        }
                        .padding(16).panel()
                    }
                    Button("Connect another tracker") { model.change(0) }.buttonStyle(ForgeButton(kind: .plain, icon: "plus"))
                }
                .padding(.horizontal, 40).padding(.top, 32).padding(.bottom, 40)
            }
            BottomBar {
                Text("Saving doesn't restart the engine. A new project is set up when it first runs.")
            } actions: {
                Button("Back to Settings") { model.go(AppModel.settingsScreen) }.buttonStyle(ForgeButton(kind: .ghost, hint: "esc"))
                    .keyboardShortcut(.cancelAction)
                Button("Save") { save() }.buttonStyle(ForgeButton(kind: .primary)).keyboardShortcut(.defaultAction)
            }
        }
        .background(Atmosphere())
        .onAppear { picked = Set(model.store.projects(in: model.workspace?.id).map(\.id)) }
        .task(id: used.map(\.id)) { await loadAll() }
    }

    private func block(_ t: TrackerRecord) -> some View {
        let all = lists[t.id] ?? []
        let shown = find.isEmpty ? all : all.filter { $0.name.localizedCaseInsensitiveContains(find) }
        let mine = all.filter { picked.contains($0.id) }.count
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                SectionLabel(text: "\(t.kind.name) · \(t.title)")
                Spacer()
                if !all.isEmpty { Text("\(mine) of \(all.count) picked").font(Theme.mono(11)).foregroundStyle(Theme.textMuted) }
            }
            .padding(.bottom, 12)
            if let p = problems[t.id] {
                ProblemLine(text: p)
            } else if lists[t.id] == nil {
                HStack(spacing: 8) {
                    Spinner(heat: true)
                    Text("Reading \(t.kind.name)…").font(Theme.sans(13)).foregroundStyle(Theme.textSec)
                }
            } else if all.isEmpty {
                Text("No projects there yet.").font(Theme.sans(13)).foregroundStyle(Theme.textSec)
            }
            ForEach(shown) { c in row(c) }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .panel()
    }

    private func row(_ c: ProjectCandidate) -> some View {
        let elsewhere = model.store.owner(of: c.id).flatMap { $0.id == model.workspace?.id ? nil : $0 }
        let locked = elsewhere != nil || c.id == running
        let note = elsewhere.map { "Managed by \($0.name)" } ?? (c.id == running ? "Running now" : c.line)
        return CheckRow(
            on: Binding(
                get: { picked.contains(c.id) || c.id == running },
                set: { on in
                    guard !locked else { return }
                    if on { picked.insert(c.id) } else { picked.remove(c.id) }
                })
        ) {
            VStack(alignment: .leading, spacing: 2) {
                Text(c.name).font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
                Text(note).font(Theme.sans(11)).foregroundStyle(Theme.textMuted)
            }
        }
        .opacity(elsewhere != nil ? 0.45 : 1)
        .padding(.vertical, 8)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1).opacity(0.6) }
    }

    private func save() {
        guard let w = model.workspace?.id else { return }
        for t in used {
            guard let all = lists[t.id] else { continue }
            let wanted = all.filter { picked.contains($0.id) && model.store.owner(of: $0.id).map { $0.id == w } != false }
            model.store.manage(wanted.map { ($0.id, $0.name, $0.ref) }, on: t.id, in: w, running: running)
            if !extra.isEmpty, extra.contains(t.id) { model.store.use(connection: t.id, in: w) }
        }
        if !model.preview { model.store.save() }
        model.go(AppModel.settingsScreen)
    }

    private func loadAll() async {
        for t in used where lists[t.id] == nil {
            do {
                lists[t.id] = model.preview ? ProjectCandidates.sample(t, model.sample) : try await ProjectCandidates.load(t)
            } catch {
                problems[t.id] = "Forge couldn't read the projects: \(error)"
            }
        }
    }
}

/// Reads a tracker connection's projects with that connection's own sign-in.
enum ProjectCandidates {
    static func load(_ t: TrackerRecord) async throws -> [ProjectCandidate] {
        let item = t.item
        switch t.kind {
        case .linear:
            guard let key = Keychain.get(named: item) else {
                throw BasecampLogin.Failure(description: "its Linear key is missing. Connect it again.")
            }
            let api = LinearAPI(key: key)
            var out: [ProjectCandidate] = []
            for team in try await api.teams() {
                for p in try await api.projects(team: team.id) {
                    out.append(
                        .init(
                            id: "\(t.id):\(p.slugId)", name: p.name, line: "Team \(team.name)",
                            ref: ProjectRef(team: team.id, projectID: p.id, slug: p.slugId)))
                }
            }
            return out
        case .basecamp:
            guard let account = t.accountID else { throw BasecampLogin.Failure(description: "Forge doesn't know its account. Connect it again.") }
            let api = BasecampAPI(accountID: account, token: { try await BasecampLogin.accessToken(item: item).accessToken })
            return try await api.projects().map { p in
                .init(
                    id: "\(t.id):\(p.id)", name: p.name, line: p.cardTables.isEmpty ? "No card table yet" : "Has a card table",
                    ref: ProjectRef(projectID: String(p.id), slug: String(p.id)))
            }
        case .github:
            let api = GitHubProjectsAPI(token: { try GitHubLogin.accessToken(item: item) })
            return try await api.projects().filter { $0.closed != true }.map { p in
                .init(id: "\(t.id):\(p.id)", name: p.title, line: "Project board #\(p.number)", ref: ProjectRef(projectID: p.id, slug: p.id))
            }
        }
    }

    /// Render mode's lists.
    @MainActor
    static func sample(_ t: TrackerRecord, _ s: AppModel.Sample) -> [ProjectCandidate] {
        switch t.kind {
        case .linear:
            let website = LinearAPI.Project(id: "p2", name: "Website", slugId: "website")
            return (s.projects + [website]).map {
                .init(
                    id: "\(t.id):\($0.slugId)", name: $0.name, line: "Team Engineering",
                    ref: ProjectRef(team: "t1", projectID: $0.id, slug: $0.slugId))
            }
        case .basecamp:
            let names = ["ConstructEase Rails Migration", "Dev Chat", "Marketing Site", "Customer Portal", "Hiring"]
            return names.enumerated().map { i, n in
                .init(
                    id: "\(t.id):\(4665 + i)", name: n, line: i < 2 ? "Has a card table" : "No card table yet",
                    ref: ProjectRef(projectID: "\(4665 + i)", slug: "\(4665 + i)"))
            }
        case .github:
            return s.githubProjects.map {
                .init(id: "\(t.id):\($0.id)", name: $0.title, line: "Project board #\($0.number)", ref: ProjectRef(projectID: $0.id, slug: $0.id))
            }
        }
    }
}
