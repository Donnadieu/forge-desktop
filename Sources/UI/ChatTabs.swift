import SwiftUI

/// A session's tabs: its chats (Chat, Chat 2, …), then Changes once the session has changed something, then + for a
/// new chat. Each chat tab shows an X on hover; right-click gives Rename and Close.
struct ChatTabs: View {
    @ObservedObject var sessions: SessionsModel
    let session: Sessions.Session
    let current: String?
    /// The right-hand side of two chats side by side: picking a tab changes that side, and there's no Changes tab.
    var side = false
    @State private var hover: String?
    @State private var renaming: String?
    @State private var name = ""
    @FocusState private var naming: Bool

    /// A tab a render draws hovered (`--render-screens` can't hover).
    @MainActor static var hoverInRender: String?

    private var changesOn: Bool { !side && sessions.changesTab.contains(session.id) && sessions.showsChangesTab(session) }

    var body: some View {
        HStack(spacing: 18) {
            ForEach(session.chats) { c in tab(c) }
            if !side, sessions.showsChangesTab(session) { changesTab }
            Button {
                sessions.newChat(in: session)
            } label: {
                Image(systemName: "plus").font(Theme.icon(.glyph)).foregroundStyle(Theme.textMuted)
            }
            .buttonStyle(.plain).help("New chat in this session (⌘T): same folder and branch")
            Spacer()
        }
    }

    private func canClose(_ c: Sessions.Chat) -> Bool { session.chats.count > 1 && !c.working }

    private func tab(_ c: Sessions.Chat) -> some View {
        let on = c.id == current && !changesOn
        let hovered = (hover ?? Self.hoverInRender) == c.id
        return HStack(spacing: 6) {
            if c.working { PulseDot(color: Theme.heat, pulsing: true, size: 5) }
            if renaming == c.id {
                TextField("", text: $name).textFieldStyle(.plain).font(Theme.sans(.body, .semibold)).foregroundStyle(Theme.text)
                    .frame(width: 120).focused($naming)
                    .onSubmit { finishRename(c) }
                    .onExitCommand { renaming = nil }
                    .onChange(of: naming) { _, focused in if !focused, renaming == c.id { finishRename(c) } }
            } else {
                Text(c.title).font(Theme.sans(.body, on ? .semibold : .regular)).foregroundStyle(on ? Theme.text : Theme.textMuted).lineLimit(1)
            }
            Button {
                sessions.close(c)
            } label: {
                Image(systemName: "xmark").font(Theme.icon(.glyphTiny, .bold)).foregroundStyle(Theme.textMuted)
                    .frame(width: 14, height: 14)
                    .background(Circle().fill(hovered ? Theme.wash2 : .clear))
            }
            .buttonStyle(.plain)
            .opacity(hovered && canClose(c) && renaming != c.id ? 1 : 0)
            .disabled(!canClose(c))
            .help("Close this chat (⌘W)")
        }
        .padding(.bottom, 10)
        .overlay(alignment: .bottom) { Rectangle().fill(on ? Theme.text : .clear).frame(height: 2) }
        .contentShape(Rectangle())
        .onHover { inside in
            if inside { hover = c.id } else if hover == c.id { hover = nil }
        }
        .onTapGesture { select(c) }
        .contextMenu {
            Button("Rename…") {
                name = c.title
                renaming = c.id
                naming = true
            }
            Button("Close") { sessions.close(c) }.disabled(!canClose(c))
            if !side, session.chats.count > 1 { Button("Open beside this one") { sessions.splitChat = c.id } }
        }
    }

    private var changesTab: some View {
        let files = sessions.changes[session.id] ?? []
        return HStack(spacing: 6) {
            Text("Changes").font(Theme.sans(.body, changesOn ? .semibold : .regular)).foregroundStyle(changesOn ? Theme.text : Theme.textMuted)
            Text("\(files.count)").font(Theme.mono(.label)).foregroundStyle(Theme.textMuted)
        }
        .padding(.bottom, 10)
        .overlay(alignment: .bottom) { Rectangle().fill(changesOn ? Theme.text : .clear).frame(height: 2) }
        .contentShape(Rectangle())
        .onTapGesture { sessions.changesTab.insert(session.id) }
        .help("Every file this session changed, to read and comment on")
    }

    private func select(_ c: Sessions.Chat) {
        if side {
            sessions.splitChat = c.id
        } else {
            sessions.activeChat[session.id] = c.id
            sessions.changesTab.remove(session.id)
        }
    }

    private func finishRename(_ c: Sessions.Chat) {
        sessions.rename(c, to: name)
        renaming = nil
    }
}

/// The Changes tab: the session's changed files on the left, one file's diff on the right to read and comment on.
struct ChangesTab: View {
    @ObservedObject var sessions: SessionsModel
    let session: Sessions.Session
    @State private var file: String?
    @State private var diff = ""

    private var files: [Sessions.FileChange] { sessions.changes[session.id] ?? [] }

    var body: some View {
        HStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(files) { f in row(f) }
                }
                .padding(8)
            }
            .frame(width: 260)
            Rectangle().fill(Theme.border).frame(width: 1)
            if let file {
                DiffReader(path: file, text: diff) { sessions.addComment($0, session: session.id) }
            } else {
                Text("Pick a file to see what changed").font(Theme.sans(.small)).foregroundStyle(Theme.textMuted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear { if file == nil, let first = files.first { open(first.path) } }
    }

    private func open(_ path: String) {
        file = path
        diff = ChangesPanel.openInRender?.diff ?? ""
        Task { if let d = try? await sessions.client?.diff(session: session.id, path: path) { diff = d } }
    }

    private func row(_ f: Sessions.FileChange) -> some View {
        Button {
            open(f.path)
        } label: {
            HStack(spacing: 10) {
                Text(f.status).font(Theme.mono(.label)).foregroundStyle(Theme.textSec).frame(width: 18, height: 18)
                    .overlay(RoundedRectangle(cornerRadius: Theme.rSm).stroke(Theme.border))
                Text(f.path).font(Theme.mono(.small)).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.head)
                Spacer(minLength: 4)
                if f.added > 0 { Text("+\(f.added)").font(Theme.mono(.caption)).foregroundStyle(Theme.good) }
                if f.removed > 0 { Text("−\(f.removed)").font(Theme.mono(.caption)).foregroundStyle(Theme.heat) }
            }
            .padding(.horizontal, 8).frame(height: 28)
            .background(RoundedRectangle(cornerRadius: Theme.rSm).fill(file == f.path ? Theme.surfaceHover : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
