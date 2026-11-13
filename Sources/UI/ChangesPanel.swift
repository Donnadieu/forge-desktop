import SwiftUI

/// The right panel (docs/design/sidebar-pr-panel.md, Direction A): what the session changed against its base, and
/// its pull request as one row, Conductor-style: the number as a link, one status kept in sync with GitHub, and the
/// one button that moves it on. With no pull request yet, a Create PR split button. Then the changed files, each
/// with its unresolved review comments, and one file's diff at a time.
struct ChangesPanel: View {
    /// The panel's usual width. Nothing inside it may be wider than the width it's given (a long branch once pushed
    /// it over the chat and its message box).
    static let width: CGFloat = SessionsLayout.changes.normal

    @ObservedObject var sessions: SessionsModel
    let session: Sessions.Session
    /// The width the screen gives it (the person drags it between `SessionsLayout.changes.min` and `.max`).
    let width: CGFloat
    @State private var confirmMerge = false
    @State private var showChecks = ChangesPanel.checksOpenInRender
    @State private var file: String? = ChangesPanel.openInRender?.path
    @State private var diff = ChangesPanel.openInRender?.diff ?? ""

    /// A file a render draws opened (`--render-screens` can't click).
    @MainActor static var openInRender: (path: String, diff: String)?
    /// Renders draw the failing checks opened.
    @MainActor static var checksOpenInRender = false

    private var files: [Sessions.FileChange] { sessions.changes[session.id] ?? [] }
    private var pr: Sessions.PullRequest? { sessions.pullRequests[session.id] }
    private var chat: Sessions.Chat? { sessions.activeChat(of: session) }

    /// The review comments line under the status: their count, shown only when comments aren't already the button.
    static func quietComments(_ pr: Sessions.PullRequest) -> Int {
        pr.status?.action == PRAction.pullComments.rawValue ? 0 : (pr.unresolved ?? 0)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PaneHeader(alignment: .topLeading) {
                VStack(alignment: .leading, spacing: 0) {
                    ChangesTitle(files: files) { moreMenu }
                    Spacer(minLength: 8)
                    if let pr {
                        PRRow(sessions: sessions, session: session, pr: pr, chat: chat, confirmMerge: $confirmMerge, showChecks: $showChecks)
                    } else if let chat, session.status != "merged" {
                        CreatePRButton(sessions: sessions, session: session, chat: chat, enabled: !files.isEmpty)
                    }
                }
                .padding(.horizontal, 16).padding(.top, 18).padding(.bottom, 16)
            }
            if let pr, (showChecks && pr.status?.action == PRAction.viewChecks.rawValue) || (pr.state == "OPEN" && Self.quietComments(pr) > 0) {
                VStack(alignment: .leading, spacing: 10) {
                    if showChecks, pr.status?.action == PRAction.viewChecks.rawValue { checksList(pr) }
                    if pr.state == "OPEN", Self.quietComments(pr) > 0 { quietCommentsLine(pr) }
                }
                .padding(.horizontal, 16).padding(.vertical, 12)
                Rectangle().fill(Theme.border).frame(height: 1)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(files) { f in fileRow(f) }
                }
                .padding(8)
            }
            .frame(maxHeight: file == nil ? .infinity : 200)
            if let file {
                Rectangle().fill(Theme.border).frame(height: 1)
                HStack {
                    Text(file).font(Theme.mono(.caption)).foregroundStyle(Theme.textSec).lineLimit(1).truncationMode(.middle)
                    Spacer()
                    Button("Comment") { sessions.openDiff = (session.id, file, diff) }
                        .buttonStyle(ForgeButton(kind: .ghost, icon: "text.bubble"))
                        .help("Open the diff large and comment on a line or a range")
                    Button {
                        self.file = nil
                    } label: {
                        Image(systemName: "xmark").font(Theme.icon(.glyphS))
                    }
                    .buttonStyle(ForgeButton(kind: .ghost))
                }
                .padding(.horizontal, 16).padding(.vertical, 8)
                DiffLines(text: diff, language: Syntax.language(path: file))
            }
        }
        .frame(width: width)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.bg)
        .clipped()
        .onAppear { sessions.refreshSide(session.id) }
        .onChange(of: session.id) { _, id in
            file = nil
            showChecks = false
            sessions.refreshSide(id)
        }
        .onChange(of: chat?.state) { _, state in if state == "idle" { sessions.refreshSide(session.id) } }
        // In sync with GitHub: when the window comes back to the front, and every minute while the panel is on screen.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            sessions.refreshSide(session.id)
        }
        .task(id: session.id) {
            guard !sessions.preview else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: SessionsModel.pollSeconds * 1_000_000_000)
                if Task.isCancelled { return }
                if NSApp?.isActive == true { sessions.refreshSide(session.id) }
            }
        }
        .confirmationDialog(Text(verbatim: "Merge PR #\(pr?.number ?? 0) into \(session.base)?"), isPresented: $confirmMerge) {
            Button("Merge") { sessions.merge(session) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("GitHub merges it the way the repo allows.")
        }
    }

    @ViewBuilder private var moreMenu: some View {
        if !files.isEmpty, chat != nil {
            Menu {
                Button("Review in a new chat") { sessions.review(session) }
            } label: {
                Image(systemName: "ellipsis")
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        }
    }

    private func quietCommentsLine(_ pr: Sessions.PullRequest) -> some View {
        HStack(spacing: 4) {
            Text(pr.unresolved == 1 ? "1 review comment ·" : "\(pr.unresolved ?? 0) review comments ·")
                .font(Theme.sans(.small)).foregroundStyle(Theme.textMuted).lineLimit(1)
            Button("Pull into chat") { sessions.pullReviewComments(session) }.buttonStyle(ForgeButton(kind: .plain))
        }
    }

    private func checksList(_ pr: Sessions.PullRequest) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(pr.failing.prefix(8).enumerated()), id: \.offset) { _, c in
                HStack(spacing: 8) {
                    Image(systemName: "xmark.circle.fill").font(Theme.icon(.glyphS)).foregroundStyle(Theme.bad)
                    Text(c.name).font(Theme.mono(.caption)).foregroundStyle(Theme.textSec).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 4)
                    if let link = c.url, !link.isEmpty, let u = URL(string: link) {
                        Button("Logs ↗") { NSWorkspace.shared.open(u) }.buttonStyle(ForgeButton(kind: .plain)).fixedSize()
                    }
                }
            }
            if pr.failing.count > 8 {
                Text("and \(pr.failing.count - 8) more").font(Theme.sans(.caption)).foregroundStyle(Theme.textMuted)
            }
            if let chat {
                Button("Fix in chat") { sessions.send(chat, text: Sessions.Prompt.fixErrors(pr.failing, number: pr.number), queue: chat.working) }
                    .buttonStyle(ForgeButton(kind: .secondary)).fixedSize()
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(Theme.surface.opacity(0.5)))
    }

    // MARK: files

    private func fileRow(_ f: Sessions.FileChange) -> some View {
        let (folder, name) = FileName.split(f.path)
        let added = f.status.hasPrefix("A") || f.status == "??"
        let deleted = f.status.hasPrefix("D")
        let comments = pr?.comments(on: f.path) ?? 0
        return Button {
            file = f.path
            diff = ""
            Task { diff = (try? await sessions.client?.diff(session: session.id, path: f.path)) ?? "" }
        } label: {
            HStack(spacing: 8) {
                (Text(folder).foregroundStyle(Theme.textMuted)
                    + Text(name).foregroundStyle(deleted ? Theme.textMuted : added ? Theme.good : Theme.text))
                    .font(Theme.mono(.small))
                    .strikethrough(deleted, color: Theme.textMuted)
                    .lineLimit(1).truncationMode(.middle)
                    .help(f.path)
                Spacer(minLength: 4)
                if comments > 0 {
                    HStack(spacing: 3) {
                        Image(systemName: "text.bubble").font(Theme.icon(.glyphXS))
                        Text("\(comments)").font(Theme.mono(.label))
                    }
                    .foregroundStyle(Theme.heat)
                    .help(comments == 1 ? "1 unresolved review comment" : "\(comments) unresolved review comments")
                }
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

/// A changed file's folder (drawn dimmed) and its name.
enum FileName {
    static func split(_ path: String) -> (String, String) {
        guard let slash = path.lastIndex(of: "/") else { return ("", path) }
        return (String(path[...slash]), String(path[path.index(after: slash)...]))
    }
}
