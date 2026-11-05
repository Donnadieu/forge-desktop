import SwiftUI

/// Settings: what Forge connects to on this Mac, as equal tiles in two columns. Each Change opens that step of
/// the setup timeline in its changing mode (every step clickable) and comes back here; the engine restarts with
/// the new answers when you go back to the Orchestrator.
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
                    PageHeader(eyebrow: "Forge · Settings", title: "Settings", lead: "What Forge connects to on this Mac.")
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

    private var tracker: some View {
        group("Tracker") {
            row {
                HStack(spacing: 12) {
                    Initials(name: c.trackerUser ?? "")
                    VStack(alignment: .leading, spacing: 2) {
                        Text(c.trackerOrg.map { "\(c.board.name) · \($0)" } ?? c.board.name).font(Theme.sans(13, .medium))
                            .foregroundStyle(Theme.text)
                        Text("Signed in as \(c.trackerUser ?? "—")").font(Theme.mono(11)).foregroundStyle(Theme.textMuted)
                    }
                }
            } action: {
                change(c.board == .linear ? "Change key" : "Change", step: 0)
            }
            row {
                field("Projects", trackerProjects)
            } action: {
                EmptyView()
            }
        }
    }

    /// The projects Forge knows on this tracker, the running one first.
    private var trackerProjects: String {
        let known = model.store.projects.filter { $0.trackerID == c.board.rawValue }.map(\.name)
        let running = c.projectName.map { [$0] } ?? []
        let names = running + known.filter { !running.contains($0) }
        return names.isEmpty ? "—" : names.joined(separator: ", ")
    }

    private var project: some View {
        group("Project") {
            row {
                field("Project", c.projectName ?? "—")
            } action: {
                change("Change", step: 1)
            }
            row {
                field("Repo", c.repo ?? "—", mono: true)
            } action: {
                change("Change", step: 3)
            }
        }
    }

    private var signing: some View {
        group("Commit signing") {
            row {
                field("GitHub", c.githubLogin.map { "@\($0)" } ?? "—", mono: true)
            } action: {
                Pill(text: "Signed in", tone: .green, dot: Theme.good)
            }
            row {
                field("Signed by", signer)
            } action: {
                change("Change", step: 2)
            }
            row {
                field("Commits as", c.authorName.map { n in c.authorEmail.map { "\(n) <\($0)>" } ?? n } ?? "—", mono: true)
            } action: {
                EmptyView()
            }
        }
    }

    private var harness: some View {
        let h = c.harnessHere
        return group("Harness engineering") {
            row {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Get your repo ready for agents").font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
                    HStack(spacing: 8) {
                        HarnessMark(badge: HarnessMark.of(h.status))
                        Text(h.status.rawValue).font(Theme.sans(11, .medium)).foregroundStyle(Theme.textSec)
                        Text(h.line).font(Theme.sans(11)).foregroundStyle(Theme.textMuted).lineLimit(1)
                    }
                }
            } action: {
                change(SettingsScreen.harnessAction(h.status), step: AppModel.harnessScreen)
            }
            row {
                field("Pull request", h.pr.map { "#\($0) \(h.merged == true ? "merged" : "open")" } ?? "None yet", mono: true)
            } action: {
                if let url = h.cardURL, let card = h.card {
                    Button("Open \(card)") { model.openLink(url) }.buttonStyle(ForgeButton(kind: .ghost))
                }
            }
        }
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
