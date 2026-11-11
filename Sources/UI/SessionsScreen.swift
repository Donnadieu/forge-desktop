import SwiftUI

/// Sessions (Direction A, "Chat first"): the workspace's sessions on the left, the chat in the middle (or two side
/// by side), and the session's changes and pull request on the right. Live changes are pushed by the sessions host.
struct SessionsScreen: View {
    @ObservedObject var model: AppModel
    @ObservedObject var sessions: SessionsModel

    private var list: [Sessions.Session] { sessions.sessions(in: model.workspace?.id) }

    var body: some View {
        VStack(spacing: 0) {
            TopBar(suffix: "Sessions") { navRight }
            HStack(spacing: 0) {
                SessionList(model: model, sessions: sessions, list: list).frame(width: 260)
                Rectangle().fill(Theme.border).frame(width: 1)
                // Each pane keeps to its own edges: the chat and its message box end where the Changes panel begins.
                center.frame(maxWidth: .infinity, maxHeight: .infinity).clipped()
                if let s = sessions.current, !sessions.composing, sessions.showChanges, sessions.split == nil {
                    Rectangle().fill(Theme.border).frame(width: 1)
                    ChangesPanel(sessions: sessions, session: s)
                }
            }
        }
        .background(Atmosphere())
        .overlay { sheets }
        .task { await sessions.connect() }
        .background(shortcuts)
    }

    @ViewBuilder private var center: some View {
        if let s = sessions.current, !sessions.composing {
            VStack(spacing: 0) {
                if let p = sessions.problem { problemLine(p) }
                if let split = sessions.split, split.id != sessions.activeChat(of: s)?.id {
                    HStack(spacing: 0) {
                        ChatColumn(model: model, sessions: sessions, session: s, compact: true)
                        Rectangle().fill(Theme.border).frame(width: 1)
                        if let other = sessions.session(of: split) {
                            ChatColumn(model: model, sessions: sessions, session: other, chatID: split.id, compact: true, closable: true)
                        }
                    }
                } else {
                    ChatColumn(model: model, sessions: sessions, session: s)
                }
            }
        } else {
            NewSessionPane(model: model, sessions: sessions)
        }
    }

    private func problemLine(_ p: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.heat)
            Text(p).font(Theme.sans(12)).foregroundStyle(Theme.text).lineLimit(2)
            Spacer()
            Button("Dismiss") { sessions.problem = nil }.buttonStyle(ForgeButton(kind: .ghost))
        }
        .padding(.horizontal, 20).padding(.vertical, 10)
        .background(Theme.warnWash)
    }

    private var navRight: some View {
        HStack(spacing: 8) {
            if let s = sessions.current, !sessions.composing {
                Button(sessions.showChanges ? "Hide changes" : "Changes") { sessions.showChanges.toggle() }
                    .buttonStyle(ForgeButton(kind: .ghost, icon: "sidebar.right"))
                    .help("Show or hide \(s.title)'s changes")
            }
            Button("Workflow Studio") { model.go(AppModel.workflowScreen) }.buttonStyle(ForgeButton(kind: .ghost, icon: "slider.horizontal.3"))
            Button("Settings") { model.go(AppModel.settingsScreen) }.buttonStyle(ForgeButton(kind: .ghost, hint: "⌘,", icon: "gearshape"))
        }
    }

    @ViewBuilder private var sheets: some View {
        if let sheet = sessions.reviewSheet, let s = sessions.sessions.first(where: { $0.id == sheet.session && sessions.belongs($0) }) {
            ReviewCommentsSheet(sessions: sessions, session: s)
        } else if let preview = sessions.importSheet {
            ImportConductorSheet(model: model, sessions: sessions, preview: preview)
        } else if sessions.showHistory {
            HistorySheet(model: model, sessions: sessions)
        } else if let d = sessions.openDiff {
            DiffSheet(path: d.path, text: d.text, comment: { sessions.addComment($0, session: d.session) }, close: { sessions.openDiff = nil })
        }
    }

    /// Conductor's keys, so the hands keep working (design section 6): ⌘N new session, ⌘T new chat, ⌘W close chat,
    /// ⌘1-9 and ⌘⌥↑↓ sessions, ⌘⌥L next chat needing you, ⌘O open in the editor, ⌘⇧A archive, ⌘⇧D changes.
    private var shortcuts: some View {
        ZStack {
            Button("") { sessions.composing = true }.keyboardShortcut("n", modifiers: .command)
            Button("") { if let s = sessions.current { sessions.newChat(in: s) } }.keyboardShortcut("t", modifiers: .command)
            Button("") { sessions.openNextNeedingYou() }.keyboardShortcut("l", modifiers: [.command, .option])
            Button("") { sessions.openNeighbour(list, by: -1) }.keyboardShortcut(.upArrow, modifiers: [.command, .option])
            Button("") { sessions.openNeighbour(list, by: 1) }.keyboardShortcut(.downArrow, modifiers: [.command, .option])
            Button("") { if let s = sessions.current, let c = sessions.activeChat(of: s) { sessions.close(c) } }
                .keyboardShortcut("w", modifiers: .command)
            Button("") { if let s = sessions.current { sessions.openInEditor(s) } }.keyboardShortcut("o", modifiers: .command)
            Button("") { if let s = sessions.current { sessions.archive(s) } }.keyboardShortcut("a", modifiers: [.command, .shift])
            Button("") { sessions.showChanges.toggle() }.keyboardShortcut("d", modifiers: [.command, .shift])
            ForEach(1..<10) { n in
                Button("") { if list.indices.contains(n - 1) { sessions.open(list[n - 1]) } }
                    .keyboardShortcut(KeyEquivalent(Character("\(n)")), modifiers: .command)
            }
        }
        .opacity(0).allowsHitTesting(false)
    }
}
