import SwiftUI

/// Settings: the workspace on screen, as equal tiles in two columns (its trackers, projects and repos,
/// intelligence provider, GitHub, Harness engineering per repo), with Rename and Delete. Each Change opens that
/// step of the setup timeline in its changing mode (every step clickable) and comes back here; the engine
/// restarts with the new answers when you go back to the Orchestrator.
struct SettingsScreen: View {
    @ObservedObject var model: AppModel

    private var c: SetupChoices { model.choices }

    var body: some View {
        VStack(spacing: 0) {
            TopBar(suffix: "Settings") {
                Button("Back to Orchestrator") { model.go(AppModel.boardScreen) }
                    .buttonStyle(ForgeButton(kind: .ghost, hint: "esc", icon: "chevron.left"))
                    .keyboardShortcut(.cancelAction)
                Button("Workflow Studio") { model.go(AppModel.workflowScreen) }
                    .buttonStyle(ForgeButton(kind: .ghost, icon: "point.topleft.down.to.point.bottomright.curvepath"))
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    PageHeader(
                        eyebrow: "\(model.workspace?.name ?? "Forge") · Workspace", title: model.workspace?.name ?? "Settings",
                        lead: "What this workspace runs. Sign-ins stay on this Mac; any workspace can use them."
                    ) {
                        HStack(spacing: 8) {
                            Button("Rename") { model.ask = .rename }.buttonStyle(ForgeButton(kind: .ghost))
                            if model.store.workspaceList.count > 1 {
                                Button("Delete workspace") { model.ask = .delete }.buttonStyle(ForgeButton(kind: .ghost, icon: "trash"))
                            }
                        }
                    }
                    .padding(.bottom, -24)
                    HStack(spacing: 8) {
                        Image(systemName: "arrow.clockwise").font(.system(size: 11, weight: .medium))
                        Text(
                            model.settingsChanged
                                ? "Changed. The engine restarts with your new answers when you go back to the Orchestrator."
                                : "Changing a setting restarts the engine. Running agents pause and pick their cards back up.")
                    }
                    .font(Theme.sans(11))
                    .foregroundStyle(model.settingsChanged ? Theme.heatBright : Theme.textMuted)
                    // Tracker → project and its repo → the project's intelligence provider and account, then the rest.
                    Grid(horizontalSpacing: 16, verticalSpacing: 16) {
                        GridRow {
                            tracker
                            project
                        }
                        GridRow {
                            intelligence
                            signing
                        }
                        GridRow {
                            harness
                            Color.clear.gridCellUnsizedAxes([.horizontal, .vertical])
                        }
                    }
                }
                .padding(.horizontal, 40).padding(.top, 32).padding(.bottom, 40)
            }
        }
        .background(Atmosphere())
        .task { await model.refreshHarness() }
    }

    /// Every tile is this tall, so the grid reads as equal tiles whatever each one holds.
    static let tileHeight: CGFloat = 200

    /// The tracker connections this workspace uses; Change opens setup 1, where more are connected.
    private var tracker: some View {
        let ids = model.workspace?.connectionIDs ?? []
        let list = ids.compactMap { model.store.connection($0) }
        return group("Trackers") {
            ForEach(list, id: \.id) { t in
                row {
                    HStack(spacing: 12) {
                        Initials(name: t.user ?? t.title)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(t.kind.name) · \(t.title)").font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
                            Text(t.line).font(Theme.mono(11)).foregroundStyle(Theme.textMuted)
                        }
                    }
                } action: {
                    if t.id == c.connection { change("Change", step: 0) }
                }
            }
            if list.isEmpty {
                row {
                    field("Tracker", "Not connected yet")
                } action: {
                    change("Connect", step: 0)
                }
            }
        }
    }

    /// The projects this workspace manages, each with its repo; the running one first. Choose opens the list of
    /// every project under its trackers.
    private var project: some View {
        group("Projects and repos") {
            ForEach(model.workspaceProjects, id: \.id) { p in
                let here = p.id == SetupStore.projectID(c)
                row {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(p.name).font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
                        Text((here ? c.repo : p.repo).map { "→ \($0)" } ?? "Not set up yet").font(Theme.mono(11))
                            .foregroundStyle((here ? c.repo : p.repo) == nil ? Theme.heatBright : Theme.textSec)
                    }
                } action: {
                    if here {
                        Pill(text: model.running ? "Running" : "Runs here", tone: .green, dot: Theme.good)
                        change("Change repo", step: 3)
                    } else {
                        Button(p.repo == nil ? "Set up" : "Run this one") { model.ask = .run(p) }.buttonStyle(ForgeButton(kind: .ghost))
                    }
                }
            }
            row {
                field("Managed", model.workspaceProjects.isEmpty ? "No projects yet" : "\(model.workspaceProjects.count) on its trackers")
            } action: {
                Button("Choose projects") { model.go(AppModel.projectsScreen) }.buttonStyle(ForgeButton(kind: .ghost))
            }
        }
    }

    private var signing: some View {
        group("GitHub") {
            row {
                field("Pushes as", c.githubLogin.map { "@\($0)" } ?? "—", mono: true)
            } action: {
                change("Change", step: 2)
            }
            row {
                field(
                    "Added in Forge", (model.store.githubAccounts ?? []).map { "@\($0.login)" }.joined(separator: ", ").ifEmpty("None yet"),
                    mono: true)
            } action: {
                EmptyView()
            }
            row {
                field("Signed by", signer)
            } action: {
                EmptyView()
            }
            row {
                field("Commits as", c.authorName.map { n in c.authorEmail.map { "\(n) <\($0)>" } ?? n } ?? "—", mono: true)
            } action: {
                EmptyView()
            }
        }
    }

    /// Harness engineering for each repo the workspace's projects build; the running project's repo can be changed.
    private var harness: some View {
        group("Harness engineering") {
            ForEach(harnessRepos, id: \.self) { repo in
                let h = c.harness?[repo] ?? HarnessRecord()
                row {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(repo).font(Theme.mono(12)).foregroundStyle(Theme.text)
                        HStack(spacing: 8) {
                            HarnessMark(badge: HarnessMark.of(h.status))
                            Text(h.status.rawValue).font(Theme.sans(11, .medium)).foregroundStyle(Theme.textSec)
                            Text(h.line).font(Theme.sans(11)).foregroundStyle(Theme.textMuted).lineLimit(1)
                        }
                    }
                } action: {
                    if repo == c.repo {
                        change(SettingsScreen.harnessAction(h.status), step: AppModel.harnessScreen)
                        if let url = h.cardURL, let card = h.card {
                            Button("Open \(card)") { model.openLink(url) }.buttonStyle(ForgeButton(kind: .ghost))
                        }
                    }
                }
            }
            if harnessRepos.isEmpty {
                row {
                    field("Repos", "No repo picked yet")
                } action: {
                    EmptyView()
                }
            }
        }
    }

    /// The repos of the workspace's projects, the running one first.
    private var harnessRepos: [String] {
        var out: [String] = []
        for r in [c.repo] + model.workspaceProjects.map(\.repo) { if let r, !out.contains(r) { out.append(r) } }
        return out
    }

    /// The Harness engineering tile's button: Start when nothing's done, Run again when partly done, Change when done.
    static func harnessAction(_ s: HarnessRecord.Status) -> String {
        switch s {
        case .notStarted: return "Start"
        case .partly: return "Run again"
        case .done: return "Change"
        }
    }

    /// The project's intelligence provider and the account it uses; Change opens setup 5, where accounts are
    /// added, switched and cleared.
    private var intelligence: some View {
        group("Intelligence provider") {
            let w = c.worker ?? .claude
            let account = model.account
            row {
                VStack(alignment: .leading, spacing: 4) {
                    Text(account.map { "\(WorkerScreen.name(w)) · \($0.name)" } ?? WorkerScreen.name(w)).font(Theme.sans(13, .medium))
                        .foregroundStyle(Theme.text)
                    HStack(spacing: 8) {
                        Circle().fill(c.workerChecked && account != nil ? Theme.good : Theme.textMuted).frame(width: 8, height: 8)
                        Text(account?.line ?? "No account picked yet").font(Theme.sans(11)).foregroundStyle(Theme.textSec)
                    }
                }
            } action: {
                change("Change", step: 4)
            }
            row {
                field("Accounts", accountCount(account?.provider ?? IntelligenceProvider(w)))
            } action: {
                EmptyView()
            }
            row {
                field("Model", c.model ?? "Its usual model", mono: c.model != nil)
            } action: {
                EmptyView()
            }
        }
    }

    private func accountCount(_ p: IntelligenceProvider) -> String {
        let n = model.store.accounts(for: p).count
        let others = model.store.accounts.count - n
        let mine = n == 1 ? "1 \(p.name) account" : "\(n) \(p.name) accounts"
        return others > 0 ? "\(mine), \(others) for other providers" : mine
    }

    private var signer: String {
        switch c.signing ?? .unsigned {
        case .forgeKey: return "Me, with a key Forge makes"
        case .ownGPG: return "Me, with my own GPG key"
        case .unsigned: return "Nobody: unsigned commits"
        }
    }

    // MARK: Pieces

    private func group<C: View>(_ title: String, @ViewBuilder rows: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel(text: title)
            VStack(spacing: 0) { rows() }
        }
        .padding(20)
        .frame(maxWidth: .infinity, minHeight: Self.tileHeight, maxHeight: .infinity, alignment: .topLeading)
        .panel()
    }

    private func row<L: View, A: View>(@ViewBuilder _ label: () -> L, @ViewBuilder action: () -> A) -> some View {
        HStack(spacing: 12) {
            label()
            Spacer(minLength: 12)
            action()
        }
        .padding(.vertical, 8)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1).opacity(0.8) }
    }

    private func field(_ key: String, _ value: String, mono: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: key)
            Text(value).font(mono ? Theme.mono(11) : Theme.sans(13)).foregroundStyle(mono ? Theme.textSec : Theme.text)
        }
    }

    private func change(_ title: String, step: Int) -> some View {
        Button(title) { model.change(step) }.buttonStyle(ForgeButton(kind: .ghost))
    }
}

extension String {
    /// This, or `other` when it's empty.
    func ifEmpty(_ other: String) -> String { isEmpty ? other : self }
}
