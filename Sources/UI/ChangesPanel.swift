import SwiftUI

/// The right panel (docs/design/sidebar-pr-panel.md, Direction A): what the session changed against its base, and
/// its pull request as one row, Conductor-style: the number as a link, one status kept in sync with GitHub, and the
/// one button that moves it on. With no pull request yet, a Create PR split button. Then the changed files, each
/// with its unresolved review comments, and one file's diff at a time.
struct ChangesPanel: View {
    /// The panel's usual width; nothing inside it may be wider than the width it's given (a long branch once pushed
    /// it over the chat and its message box).
    static let width: CGFloat = SessionsLayout.changes.normal

    @ObservedObject var sessions: SessionsModel
    let session: Sessions.Session
    var width: CGFloat = ChangesPanel.width
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
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    Text(files.isEmpty ? "No changes yet" : "Changes · \(files.count == 1 ? "1 file" : "\(files.count) files")")
                        .font(Theme.sans(14, .semibold)).foregroundStyle(Theme.text)
                    if !files.isEmpty {
                        Text("+\(files.reduce(0) { $0 + $1.added })").font(Theme.mono(11)).foregroundStyle(Theme.good)
                        Text("−\(files.reduce(0) { $0 + $1.removed })").font(Theme.mono(11)).foregroundStyle(Theme.heat)
                    }
                    Spacer()
                    if !files.isEmpty, chat != nil {
                        Menu {
                            Button("Review in a new chat") { sessions.review(session) }
                        } label: {
                            Image(systemName: "ellipsis")
                        }
                        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    }
                }
                prRow
                if showChecks, let pr, pr.status?.action == PRAction.viewChecks.rawValue { checksList(pr) }
                if let pr, pr.state == "OPEN", Self.quietComments(pr) > 0 {
                    HStack(spacing: 4) {
                        Text(pr.unresolved == 1 ? "1 review comment ·" : "\(pr.unresolved ?? 0) review comments ·")
                            .font(Theme.sans(12)).foregroundStyle(Theme.textMuted)
                        Button("Pull into chat") { sessions.pullReviewComments(session) }.buttonStyle(ForgeButton(kind: .plain))
                    }
                }
            }
            .padding(16)
            Rectangle().fill(Theme.border).frame(height: 1)
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
                    Text(file).font(Theme.mono(11)).foregroundStyle(Theme.textSec).lineLimit(1).truncationMode(.middle)
                    Spacer()
                    Button("Comment") { sessions.openDiff = (session.id, file, diff) }
                        .buttonStyle(ForgeButton(kind: .ghost, icon: "text.bubble"))
                        .help("Open the diff large and comment on a line or a range")
                    Button {
                        self.file = nil
                    } label: {
                        Image(systemName: "xmark").font(.system(size: 10))
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

    // MARK: the pull request row

    @ViewBuilder private var prRow: some View {
        if let pr {
            HStack(spacing: 8) {
                Button {
                    if let u = URL(string: pr.url) { NSWorkspace.shared.open(u) }
                } label: {
                    HStack(spacing: 4) {
                        Text(verbatim: "#\(pr.number)").font(Theme.mono(11, .medium)).foregroundStyle(Theme.text)
                        Image(systemName: "arrow.up.right").font(.system(size: 8, weight: .semibold)).foregroundStyle(Theme.textMuted)
                    }
                    .padding(.horizontal, 7).frame(height: 22)
                    .overlay(RoundedRectangle(cornerRadius: Theme.rSm).stroke(Theme.border))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).fixedSize()
                .help("Open PR #\(pr.number) on GitHub")
                if let st = pr.status {
                    if st.tone == "checking" {
                        Spinner()
                    } else {
                        Circle().fill(Self.tone(st.tone)).frame(width: 7, height: 7)
                    }
                    Text(st.label).font(Theme.sans(12, .medium)).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.tail)
                } else {
                    Text(pr.state.capitalized).font(Theme.sans(12, .medium)).foregroundStyle(Theme.text)
                }
                Spacer(minLength: 4)
                if let action = pr.status?.action.flatMap(PRAction.init(rawValue:)) { button(action, pr) }
            }
        } else if let chat, session.status != "merged" {
            createPR(chat)
        }
    }

    static func tone(_ t: String) -> Color {
        switch t {
        case "ready", "merged": return Theme.good
        case "failing": return Theme.bad
        case "blocked": return Theme.heat
        default: return Theme.textMuted
        }
    }

    @ViewBuilder private func button(_ a: PRAction, _ pr: Sessions.PullRequest) -> some View {
        if a == .merge {
            Button(a.title) { run(a, pr) }
                .buttonStyle(ForgeButton(kind: .primary, hint: "⌘⇧M")).keyboardShortcut("m", modifiers: [.command, .shift]).fixedSize()
        } else {
            Button(a.title) { run(a, pr) }
                .buttonStyle(ForgeButton(kind: .primary)).fixedSize().disabled(a.needsChat && chat == nil)
        }
    }

    private func run(_ a: PRAction, _ pr: Sessions.PullRequest) {
        switch a {
        case .merge: confirmMerge = true
        case .resolve:
            if let chat { sessions.send(chat, text: Sessions.Prompt.resolveConflicts(base: pr.base ?? session.base), queue: chat.working) }
        case .update: sessions.update(session)
        case .viewChecks: showChecks.toggle()
        case .pullComments: sessions.pullReviewComments(session)
        case .readyForReview: sessions.ready(session)
        case .open: if let u = URL(string: pr.url) { NSWorkspace.shared.open(u) }
        }
    }

    private func checksList(_ pr: Sessions.PullRequest) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(pr.failing.prefix(8).enumerated()), id: \.offset) { _, c in
                HStack(spacing: 8) {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 10)).foregroundStyle(Theme.bad)
                    Text(c.name).font(Theme.mono(11)).foregroundStyle(Theme.textSec).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 4)
                    if let link = c.url, !link.isEmpty, let u = URL(string: link) {
                        Button("Logs ↗") { NSWorkspace.shared.open(u) }.buttonStyle(ForgeButton(kind: .plain)).fixedSize()
                    }
                }
            }
            if pr.failing.count > 8 {
                Text("and \(pr.failing.count - 8) more").font(Theme.sans(11)).foregroundStyle(Theme.textMuted)
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

    /// No pull request yet: Create PR sends the agent the create-PR prompt; the arrow has a draft one, or pushes the
    /// branch and opens GitHub's own page for it.
    private func createPR(_ chat: Sessions.Chat) -> some View {
        HStack(spacing: 1) {
            Button("Create PR") {
                sessions.send(chat, text: Sessions.Prompt.createPR(base: session.base, branch: session.branch), queue: chat.working)
            }
            .buttonStyle(ForgeButton(kind: .primary, hint: "⌘⇧P"))
            .keyboardShortcut("p", modifiers: [.command, .shift])
            Menu {
                Button("Create draft PR") {
                    sessions.send(chat, text: Sessions.Prompt.createPR(base: session.base, branch: session.branch, draft: true), queue: chat.working)
                }
                Button("Create PR manually ↗") { sessions.publish(session) }
            } label: {
                Color.clear.frame(width: 26, height: 30).contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .frame(width: 26, height: 30)
            // The arrow is drawn under the menu: a borderless menu tints its own label amber, on amber.
            .background {
                RoundedRectangle(cornerRadius: Theme.rMd).fill(Theme.heat)
                    .overlay(Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.bg))
            }
            .help("Create draft PR, or Create PR manually")
        }
        .fixedSize()
        .disabled(files.isEmpty)
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
                    .font(Theme.mono(12))
                    .strikethrough(deleted, color: Theme.textMuted)
                    .lineLimit(1).truncationMode(.middle)
                    .help(f.path)
                Spacer(minLength: 4)
                if comments > 0 {
                    HStack(spacing: 3) {
                        Image(systemName: "text.bubble").font(.system(size: 9))
                        Text("\(comments)").font(Theme.mono(10))
                    }
                    .foregroundStyle(Theme.heat)
                    .help(comments == 1 ? "1 unresolved review comment" : "\(comments) unresolved review comments")
                }
                if f.added > 0 { Text("+\(f.added)").font(Theme.mono(11)).foregroundStyle(Theme.good) }
                if f.removed > 0 { Text("−\(f.removed)").font(Theme.mono(11)).foregroundStyle(Theme.heat) }
            }
            .padding(.horizontal, 8).frame(height: 28)
            .background(RoundedRectangle(cornerRadius: Theme.rSm).fill(file == f.path ? Theme.surfaceHover : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The one button the pull request row shows, from the host's status (`mergeStatus` in engine sessions/github.ts).
enum PRAction: String {
    case merge, resolve, update
    case viewChecks = "view_checks"
    case pullComments = "pull_comments"
    case readyForReview = "ready_for_review"
    case open

    var title: String {
        switch self {
        case .merge: return "Merge"
        case .resolve: return "Resolve"
        case .update: return "Update"
        case .viewChecks: return "View"
        case .pullComments: return "Pull into chat"
        case .readyForReview: return "Ready for review"
        case .open: return "View on GitHub"
        }
    }

    /// Sends the agent a message, so it needs the session's chat.
    var needsChat: Bool { self == .resolve }
}

/// A changed file's folder (drawn dimmed) and its name.
enum FileName {
    static func split(_ path: String) -> (String, String) {
        guard let slash = path.lastIndex(of: "/") else { return ("", path) }
        return (String(path[...slash]), String(path[path.index(after: slash)...]))
    }
}
