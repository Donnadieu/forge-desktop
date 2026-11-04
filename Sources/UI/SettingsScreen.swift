import SwiftUI

/// Settings: what Forge connects to on this Mac. Each Change opens that setup step and comes back here; the
/// engine restarts with the new answers when you go back to the Orchestrator.
struct SettingsScreen: View {
    @ObservedObject var model: AppModel

    private var c: SetupChoices { model.choices }

    var body: some View {
        VStack(spacing: 0) {
            TopBar(suffix: "Settings") {
                Button("Back to Orchestrator") { model.go(AppModel.boardScreen) }
                    .buttonStyle(ForgeButton(kind: .ghost, hint: "esc", icon: "chevron.left"))
                    .keyboardShortcut(.cancelAction)
                Button("Workflow") { model.go(AppModel.workflowScreen) }
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
                    HStack(alignment: .top, spacing: 16) {
                        VStack(spacing: 16) {
                            tracker
                            code
                            signing
                        }
                        agents
                    }
                }
                .padding(.horizontal, 40).padding(.top, 32).padding(.bottom, 40)
            }
        }
        .background(Atmosphere())
    }

    private var tracker: some View {
        group("Tracker") {
            row {
                HStack(spacing: 12) {
                    Initials(name: c.linearUser ?? "")
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Linear · \(c.linearOrg ?? "Linear")").font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
                        Text("Signed in as \(c.linearUser ?? "—")").font(Theme.mono(11)).foregroundStyle(Theme.textMuted)
                    }
                }
            } action: {
                change("Change key", step: 0)
            }
            row {
                field("Project", c.projectName ?? "—")
            } action: {
                change("Change", step: 1)
            }
        }
    }

    private var code: some View {
        group("Code") {
            row {
                field("GitHub", c.githubLogin.map { "@\($0)" } ?? "—", mono: true)
            } action: {
                Pill(text: "Signed in", tone: .green, dot: Theme.good)
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
                field("Signed by", signer)
            } action: {
                change("Change", step: 2)
            }
        }
    }

    private var agents: some View {
        group("Agent") {
            let w = c.worker ?? .claude
            row {
                VStack(alignment: .leading, spacing: 4) {
                    Text(WorkerScreen.name(w)).font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
                    HStack(spacing: 8) {
                        Circle().fill(c.workerChecked ? Theme.good : Theme.textMuted).frame(width: 8, height: 8)
                        Text(w.usesKey ? "API key set · in Keychain" : "Signed in with your browser").font(Theme.sans(11)).foregroundStyle(
                            Theme.textSec)
                    }
                    if let m = c.model { Text(m).font(Theme.mono(11)).foregroundStyle(Theme.textMuted) }
                }
            } action: {
                change("Change", step: 4)
            }
        }
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
        .frame(maxWidth: .infinity, alignment: .leading)
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
