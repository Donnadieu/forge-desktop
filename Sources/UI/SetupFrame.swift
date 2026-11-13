import SwiftUI

/// The frame every setup screen shares (the Setup shell): the top bar, the steps down the left as a
/// stage spine, the page header, one question's content, and the sticky bottom bar with Back and the
/// one main button. Opened from Settings (changing), it reads as Settings, not as a first run.
struct SetupFrame<Content: View>: View {
    @ObservedObject var model: AppModel
    let question: String
    let detail: String
    let primary: String
    let primaryEnabled: Bool
    let busy: Bool
    let action: () -> Void
    /// A second, quieter choice beside the main button ("Skip for now").
    var secondary: (title: String, action: () -> Void)? = nil
    @ObservedObject var updater = Updater.shared
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            TopBar(suffix: model.changing ? "Settings" : "Setup")
            HStack(spacing: 0) {
                SetupSidebar(model: model, updater: updater)
                VStack(spacing: 0) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            PageHeader(eyebrow: eyebrow, title: question, lead: detail)
                            content()
                        }
                        .padding(.horizontal, 40)
                        .padding(.top, 32)
                        .padding(.bottom, 40)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    footer
                }
            }
        }
        .background(Atmosphere())
    }

    private var eyebrow: String {
        let title = AppModel.screenTitles[min(model.screen, AppModel.screenTitles.count - 1)]
        return model.changing ? "Settings · \(title)" : "Setup · Step \(model.screen + 1) of 6"
    }

    private var footer: some View {
        BottomBar {
            if busy {
                HStack(spacing: 8) {
                    Spinner(heat: true)
                    Text("Working…")
                }
            } else if model.changing && model.screen == AppModel.harnessScreen {
                Text("Nothing here restarts the engine.")
            } else if model.changing {
                Text("Continue saves your answers and restarts the engine.")
            } else {
                Text("Continue saves your answers.")
            }
        } actions: {
            if let back = model.returnTo {
                Button(back == AppModel.settingsScreen ? "Back to Settings" : "Back") { model.go(back) }
                    .buttonStyle(ForgeButton(kind: .ghost, large: true))
            } else if model.screen > 0 {
                Button("Back") { model.go(model.screen - 1) }
                    .buttonStyle(ForgeButton(kind: .ghost, hint: "⌘[", large: true))
                    .keyboardShortcut("[", modifiers: .command)
            }
            if let s = secondary {
                Button(s.title, action: s.action)
                    .buttonStyle(ForgeButton(kind: .secondary, large: true))
                    .disabled(busy)
            }
            Button(primary, action: action)
                .buttonStyle(ForgeButton(kind: .primary, hint: "↵", large: true))
                .keyboardShortcut(.defaultAction)
                .disabled(!primaryEnabled || busy)
        }
    }
}

/// The steps down the left, drawn as the stage spine: done (dim node), here (cream node with a ring,
/// the row raised), to come (hollow node). Changing from Settings, every step is a button and carries its
/// own mark: a check when done, a half-filled circle when harness engineering is partly done, an empty
/// red circle when not done.
struct SetupSidebar: View {
    @ObservedObject var model: AppModel
    @ObservedObject var updater: Updater

    var body: some View {
        let changing = model.changing
        let steps = AppModel.listedSteps(changing: changing)
        VStack(alignment: .leading, spacing: 16) {
            SectionLabel(text: changing ? "Your setup" : "Steps").padding(.horizontal, 8)
            VStack(spacing: 0) {
                ForEach(steps, id: \.self) { i in
                    let row = StepRow(
                        number: i + 1, title: AppModel.screenTitles[i], goal: !changing && i == AppModel.boardScreen,
                        state: state(i, changing: changing), badge: badge(i, changing: changing),
                        first: i == steps.first, last: i == steps.last, clickable: changing && i != model.screen)
                    if changing {
                        Button {
                            model.change(i)
                        } label: {
                            row
                        }.buttonStyle(.plain)
                    } else {
                        row
                    }
                }
            }
            Spacer()
            if let rel = updater.available, !model.preview {
                // Answers are saved screen by screen, so updating mid-setup picks up where it left off.
                Button(updater.installing ? "Updating…" : "Update to \(rel.version)") { Task { await updater.install() } }
                    .buttonStyle(ForgeButton(kind: .primary))
                    .disabled(updater.installing)
            }
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: changing ? "hand.point.up.left" : "lock").font(Theme.icon(.glyphS, .medium))
                Text(changing ? "Pick any step to change it. Continue saves it on this Mac." : "Continue saves your answers on this Mac.")
                    .fixedSize(horizontal: false, vertical: true)
            }
            .font(Theme.sans(.caption))
            .foregroundStyle(Theme.textMuted)
            .padding(.horizontal, 8)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 24)
        .frame(width: 288, alignment: .topLeading)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.wash1)
        .overlay(alignment: .trailing) { Rectangle().fill(Theme.border).frame(width: 1) }
    }

    private func state(_ i: Int, changing: Bool) -> StepRow.Mark {
        if i == model.screen { return .here }
        if changing { return model.choices.stepDone(i) ? .done : .later }
        return i < model.screen ? .done : .later
    }

    private func badge(_ i: Int, changing: Bool) -> StepRow.Badge {
        guard changing else { return i < model.screen && i != AppModel.boardScreen ? .tick : .none }
        return StepRow.badge(step: i, choices: model.choices)
    }
}

struct StepRow: View {
    enum Mark { case done, here, later }
    /// The mark at the end of the row.
    enum Badge: Equatable { case none, tick, check, half, notDone }
    let number: Int
    let title: String
    var goal = false
    let state: Mark
    var badge: Badge = .none
    var first = false
    var last = false
    var clickable = false
    @State private var hover = false

    /// Changing from Settings: a check for each done step; harness engineering shows how far along it is.
    static func badge(step: Int, choices: SetupChoices) -> Badge {
        guard step == AppModel.harnessScreen else { return choices.stepDone(step) ? .check : .notDone }
        return HarnessMark.of(choices.harnessHere.status)
    }

    var body: some View {
        HStack(spacing: 8) {
            ZStack {
                Rectangle().fill(Theme.border).frame(width: 1)
                    .padding(.top, first ? 20 : 0)
                    .padding(.bottom, last ? 20 : 0)
                node
            }
            .frame(width: 24)
            HStack(spacing: 10) {
                if goal {
                    Text("→ \(title.uppercased())").font(Theme.mono(.caption)).tracking(1.5).foregroundStyle(Theme.textMuted)
                } else {
                    Text(String(format: "%02d", number)).font(Theme.mono(.caption)).foregroundStyle(state == .here ? Theme.textSec : Theme.textMuted)
                    Text(title)
                        .font(Theme.sans(.body, state == .here ? .semibold : .regular))
                        .foregroundStyle(state == .here || hover ? Theme.text : (state == .done ? Theme.textSec : Theme.textMuted))
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                HarnessMark(badge: badge)
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
            .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(state == .here ? Theme.surface : (hover ? Theme.wash2 : .clear)))
            .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(state == .here ? Theme.border : .clear))
        }
        // A fixed height keeps the steps together; the spine line inside would otherwise stretch each row.
        .frame(height: 44)
        .contentShape(Rectangle())
        .onHover { hover = clickable && $0 }
    }

    @ViewBuilder private var node: some View {
        switch state {
        case .here:
            Circle().fill(Theme.text).frame(width: 9, height: 9)
                .padding(2).background(Circle().stroke(Theme.wash3, lineWidth: 2))
                .background(Circle().fill(Theme.bg).padding(-4))
        case .done:
            Circle().fill(Theme.textMuted).frame(width: 9, height: 9).background(Circle().fill(Theme.bg).padding(-4))
        case .later:
            Circle().stroke(Theme.faint).frame(width: 8, height: 8).background(Circle().fill(Theme.bg).padding(-4))
        }
    }
}
