import SwiftUI

/// The right panel: what the session changed against its base, the one next step (Create PR, Fix errors, Merge),
/// its pull request with the checks and the review comments, and one file's diff at a time.
struct ChangesPanel: View {
    /// The panel's width on the Sessions screen; nothing inside it may be wider (a long branch once pushed it over
    /// the chat and its message box).
    static let width: CGFloat = 360

    @ObservedObject var sessions: SessionsModel
    let session: Sessions.Session
    @State private var confirmMerge = false
    @State private var file: String? = ChangesPanel.openInRender?.path
    @State private var diff = ChangesPanel.openInRender?.diff ?? ""

    /// A file a render draws opened (`--render-screens` can't click).
    @MainActor static var openInRender: (path: String, diff: String)?

    private var files: [Sessions.FileChange] { sessions.changes[session.id] ?? [] }
    private var pr: Sessions.PullRequest? { sessions.pullRequests[session.id] }
    private var chat: Sessions.Chat? { sessions.activeChat(of: session) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Text(files.isEmpty ? "No changes yet" : "Changes · \(files.count == 1 ? "1 file" : "\(files.count) files")")
                        .font(Theme.sans(14, .semibold)).foregroundStyle(Theme.text)
                    if !files.isEmpty {
                        Text("+\(files.reduce(0) { $0 + $1.added })").font(Theme.mono(11)).foregroundStyle(Theme.good)
                        Text("−\(files.reduce(0) { $0 + $1.removed })").font(Theme.mono(11)).foregroundStyle(Theme.heat)
                    }
                    Spacer()
                    Button {
                        sessions.refreshSide(session.id)
                    } label: {
                        Image(systemName: "arrow.clockwise").font(.system(size: 11))
                    }
                    .buttonStyle(ForgeButton(kind: .ghost)).help("Look again")
                }
                HStack(spacing: 6) {
                    Image(systemName: "arrow.triangle.branch").font(.system(size: 10)).foregroundStyle(Theme.textMuted)
                    Chip(text: session.branch, fits: true)
                    Text("vs \(session.base)").font(Theme.mono(10)).foregroundStyle(Theme.textMuted).fixedSize()
                }
                prLine
                actions
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
                    Text(file).font(Theme.mono(11)).foregroundStyle(Theme.textSec).lineLimit(1)
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
        .frame(width: Self.width)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.bg)
        .clipped()
        .onAppear { sessions.refreshSide(session.id) }
        .onChange(of: session.id) { _, id in
            file = nil
            sessions.refreshSide(id)
        }
        .onChange(of: chat?.state) { _, state in if state == "idle" { sessions.refreshSide(session.id) } }
        .confirmationDialog("Merge PR #\(pr?.number ?? 0) into \(session.base)?", isPresented: $confirmMerge) {
            Button("Merge") { sessions.merge(session) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(pr?.failing.isEmpty == false ? "\(pr?.failing.count ?? 0) checks are failing." : "GitHub merges it the way the repo allows.")
        }
    }

    @ViewBuilder private var prLine: some View {
        if let pr {
            HStack(spacing: 8) {
                Pill(text: "PR #\(pr.number) · \(pr.state.capitalized)", tone: pr.state == "MERGED" ? .green : .info)
                if !pr.failing.isEmpty {
                    Text("\(pr.failing.count) failing").font(Theme.sans(11)).foregroundStyle(Theme.heat)
                } else if !pr.checks.isEmpty {
                    Text("Checks pass").font(Theme.sans(11)).foregroundStyle(Theme.textMuted)
                }
                Spacer()
                Button("Open ↗") { if let u = URL(string: pr.url) { NSWorkspace.shared.open(u) } }.buttonStyle(ForgeButton(kind: .plain))
            }
        }
    }

    @ViewBuilder private var actions: some View {
        HStack(spacing: 8) {
            if let chat, session.status != "merged" {
                if pr == nil {
                    Button("Create PR") {
                        sessions.send(chat, text: Sessions.Prompt.createPR(base: session.base, branch: session.branch), queue: chat.working)
                    }
                    .buttonStyle(ForgeButton(kind: .primary, hint: "⌘⇧P", large: true))
                    .keyboardShortcut("p", modifiers: [.command, .shift])
                    .disabled(files.isEmpty)
                } else if let pr, pr.state == "OPEN" {
                    if !pr.failing.isEmpty {
                        Button("Fix errors") {
                            sessions.send(chat, text: Sessions.Prompt.fixErrors(pr.failing, number: pr.number), queue: chat.working)
                        }
                        .buttonStyle(ForgeButton(kind: .primary, hint: "⌘⇧X", large: true))
                        .keyboardShortcut("x", modifiers: [.command, .shift])
                    }
                    Button("Pull review comments") { sessions.pullReviewComments(session) }
                        .buttonStyle(ForgeButton(kind: .secondary, large: true))
                    Button("Merge") { confirmMerge = true }
                        .buttonStyle(ForgeButton(kind: pr.failing.isEmpty ? .primary : .secondary, hint: "⌘⇧M", large: true))
                        .keyboardShortcut("m", modifiers: [.command, .shift])
                }
                Menu {
                    Button("Review in a new chat") { sessions.review(session) }.disabled(files.isEmpty)
                    Button("Archive this session") { sessions.archive(session) }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            }
        }
    }

    private func fileRow(_ f: Sessions.FileChange) -> some View {
        Button {
            file = f.path
            diff = ""
            Task { diff = (try? await sessions.client?.diff(session: session.id, path: f.path)) ?? "" }
        } label: {
            HStack(spacing: 10) {
                Text(f.status).font(Theme.mono(10)).foregroundStyle(Theme.textSec).frame(width: 18, height: 18)
                    .overlay(RoundedRectangle(cornerRadius: Theme.rSm).stroke(Theme.border))
                Text(f.path.split(separator: "/").last.map(String.init) ?? f.path).font(Theme.mono(12)).foregroundStyle(Theme.text).lineLimit(1)
                    .help(f.path)
                Spacer()
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
