import SwiftUI

/// Sessions (Direction A, "Chat first"): the workspace's sessions on the left, the chat in the middle (or two side
/// by side), and the session's changes and pull request on the right. Live changes are pushed by the sessions host.
struct SessionsScreen: View {
    @ObservedObject var model: AppModel
    @ObservedObject var sessions: SessionsModel

    private var list: [Sessions.Session] { sessions.sessions(in: model.workspace?.id) }
    private var panelSession: Sessions.Session? {
        guard let s = sessions.current, !sessions.composing, sessions.split == nil else { return nil }
        return s
    }

    var body: some View {
        VStack(spacing: 0) {
            TopBar(suffix: "Sessions", leading: AnyView(SidebarToggle(side: .left, open: $sessions.showSessions))) { navRight }
            GeometryReader { geo in
                let fit = SessionsLayout.fit(
                    total: geo.size.width, left: sessions.leftWidth, right: sessions.rightWidth, leftOpen: sessions.showSessions,
                    rightOpen: sessions.showChanges && panelSession != nil)
                HStack(spacing: 0) {
                    if let w = fit.left {
                        SessionList(model: model, sessions: sessions, list: list).frame(width: w)
                        PaneDivider(side: .left, width: $sessions.leftWidth, open: $sessions.showSessions).zIndex(1)
                    }
                    // Each pane keeps to its own edges: the chat and its message box end where the Changes panel begins.
                    center.frame(maxWidth: .infinity, maxHeight: .infinity).clipped()
                    if let w = fit.right, let s = panelSession {
                        PaneDivider(side: .right, width: $sessions.rightWidth, open: $sessions.showChanges).zIndex(1)
                        ChangesPanel(sessions: sessions, session: s, width: w)
                    }
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
            // Under the header, so the header's line stays level with the other panes'.
            .overlay(alignment: .top) { if let p = sessions.problem { problemLine(p).padding(.top, SessionsLayout.headerHeight) } }
        } else {
            NewSessionPane(model: model, sessions: sessions)
        }
    }

    private func problemLine(_ p: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.heat)
            Text(p).font(Theme.sans(.small)).foregroundStyle(Theme.text).lineLimit(2)
            Spacer()
            Button("Dismiss") { sessions.problem = nil }.buttonStyle(ForgeButton(kind: .ghost))
        }
        .padding(.horizontal, 20).padding(.vertical, 10)
        .background(Theme.warnWash)
    }

    private var navRight: some View {
        HStack(spacing: 8) {
            if sessions.current != nil, !sessions.composing {
                SidebarToggle(side: .right, open: $sessions.showChanges)
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
        } else if let ask = sessions.archiveAsk {
            ArchiveSheet(sessions: sessions, ask: ask)
        } else if let s = sessions.renameAsk {
            RenameBranchSheet(sessions: sessions, session: s)
        } else if let d = sessions.openDiff {
            DiffSheet(path: d.path, text: d.text, comment: { sessions.addComment($0, session: d.session) }, close: { sessions.openDiff = nil })
        } else if let f = sessions.openFile {
            FileSheet(sessions: sessions, file: f) { sessions.openFile = nil }
        }
    }

    /// Conductor's keys, so the hands keep working (design section 6): ⌘N new session, ⌘T new chat, ⌘W close chat,
    /// ⌘1-9 and ⌘⌥↑↓ sessions, ⌘⌥L next chat needing you, ⌘O open in the app used last, ⌘⇧A archive, ⌘⇧D changes,
    /// ⌘⇧S the sessions list.
    private var shortcuts: some View {
        ZStack {
            Button("") { sessions.composing = true }.keyboardShortcut("n", modifiers: .command)
            Button("") { if let s = sessions.current { sessions.newChat(in: s) } }.keyboardShortcut("t", modifiers: .command)
            Button("") { sessions.openNextNeedingYou() }.keyboardShortcut("l", modifiers: [.command, .option])
            Button("") { sessions.openNeighbour(list, by: -1) }.keyboardShortcut(.upArrow, modifiers: [.command, .option])
            Button("") { sessions.openNeighbour(list, by: 1) }.keyboardShortcut(.downArrow, modifiers: [.command, .option])
            Button("") { if let s = sessions.current, let c = sessions.activeChat(of: s) { sessions.close(c) } }
                .keyboardShortcut("w", modifiers: .command)
            Button("") { if let s = sessions.current { OpenInModel.shared.openDefault(s, checkouts: model.mainCheckouts(of: s)) } }
                .keyboardShortcut("o", modifiers: .command)
            Button("") { if let s = sessions.current { sessions.requestArchive(s) } }.keyboardShortcut("a", modifiers: [.command, .shift])
            Button("") { sessions.showChanges.toggle() }.keyboardShortcut("d", modifiers: [.command, .shift])
            Button("") { sessions.showSessions.toggle() }.keyboardShortcut("s", modifiers: [.command, .shift])
            ForEach(1..<10) { n in
                Button("") { if list.indices.contains(n - 1) { sessions.open(list[n - 1]) } }
                    .keyboardShortcut(KeyEquivalent(Character("\(n)")), modifiers: .command)
            }
        }
        .opacity(0).allowsHitTesting(false)
    }
}
