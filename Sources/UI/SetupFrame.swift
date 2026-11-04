import SwiftUI

/// The frame every setup screen shares (the Setup shell): the top bar, the steps down the left as a
/// stage spine, the page header, one question's content, and the sticky bottom bar with Back and the
/// one main button.
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
            TopBar(suffix: "Setup")
            HStack(spacing: 0) {
                SetupSidebar(model: model, updater: updater)
                VStack(spacing: 0) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            PageHeader(eyebrow: "Setup · Step \(model.screen + 1) of 6", title: question, lead: detail)
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

    private var footer: some View {
        BottomBar {
            if busy {
                HStack(spacing: 8) {
                    Spinner(heat: true)
                    Text("Working…")
                }
            } else if model.returnTo != nil {
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
/// the row raised), to come (hollow node).
struct SetupSidebar: View {
    @ObservedObject var model: AppModel
    @ObservedObject var updater: Updater

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            SectionLabel(text: "Steps").padding(.horizontal, 8)
            VStack(spacing: 0) {
                ForEach(Array(AppModel.screenTitles.enumerated()), id: \.offset) { i, title in
                    StepRow(
                        number: i + 1, title: title, goal: i == AppModel.boardScreen,
                        state: i < model.screen ? .done : (i == model.screen ? .here : .later),
                        first: i == 0, last: i == AppModel.screenTitles.count - 1)
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
                Image(systemName: "lock").font(.system(size: 10, weight: .medium))
                Text("Continue saves your answers on this Mac.").fixedSize(horizontal: false, vertical: true)
            }
            .font(Theme.sans(11))
            .foregroundStyle(Theme.textMuted)
            .padding(.horizontal, 8)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 24)
        .frame(width: 248, alignment: .topLeading)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.wash1)
        .overlay(alignment: .trailing) { Rectangle().fill(Theme.border).frame(width: 1) }
    }
}

struct StepRow: View {
    enum Mark { case done, here, later }
    let number: Int
    let title: String
    var goal = false
    let state: Mark
    var first = false
    var last = false

    var body: some View {
        HStack(spacing: 8) {
            ZStack {
                Rectangle().fill(Theme.border).frame(width: 1)
                    .padding(.top, first ? 20 : 0)
                    .padding(.bottom, last ? 20 : 0)
                node
            }
            .frame(width: 24)
            HStack(spacing: 12) {
                if goal {
                    Text("→ \(title.uppercased())").font(Theme.mono(11)).tracking(1.5).foregroundStyle(Theme.textMuted)
                } else {
                    Text(String(format: "%02d", number)).font(Theme.mono(11)).foregroundStyle(state == .here ? Theme.textSec : Theme.textMuted)
                    Text(title)
                        .font(Theme.sans(13, state == .here ? .semibold : .regular))
                        .foregroundStyle(state == .here ? Theme.text : (state == .done ? Theme.textSec : Theme.textMuted))
                }
                Spacer(minLength: 0)
                if state == .done && !goal {
                    Image(systemName: "checkmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.textMuted)
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
            .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(state == .here ? Theme.surface : .clear))
            .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(state == .here ? Theme.border : .clear))
        }
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
