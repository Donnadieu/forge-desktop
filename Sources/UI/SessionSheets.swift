import SwiftUI

/// The frame every sessions sheet shares: a dimmed window, a panel, the title and one line under it, the body, and
/// the buttons at the bottom. Esc or a click outside closes it.
struct SessionSheet<Content: View, Buttons: View>: View {
    let title: String
    let lead: String
    let close: () -> Void
    @ViewBuilder var content: Content
    @ViewBuilder var buttons: Buttons

    var body: some View {
        ZStack {
            Color.black.opacity(0.5).ignoresSafeArea().onTapGesture(perform: close)
            VStack(alignment: .leading, spacing: 0) {
                Text(title).font(Theme.display(24)).foregroundStyle(Theme.text)
                Text(lead).font(Theme.sans(12)).foregroundStyle(Theme.textSec).padding(.top, 6).fixedSize(horizontal: false, vertical: true)
                content.padding(.top, 16)
                HStack(spacing: 8) {
                    Spacer()
                    Button("Cancel", action: close).buttonStyle(ForgeButton(kind: .ghost, large: true)).keyboardShortcut(.escape, modifiers: [])
                    buttons
                }
                .padding(.top, 20)
            }
            .padding(24)
            .frame(width: 640)
            .background(RoundedRectangle(cornerRadius: Theme.rXl).fill(Theme.bg))
            .overlay(RoundedRectangle(cornerRadius: Theme.rXl).stroke(Theme.border))
            .shadow(color: .black.opacity(0.5), radius: 30)
        }
    }
}

/// "Pull PR review comments into this chat": the pull request's threads, unresolved ones ticked, outdated and
/// resolved ones marked. The ticked ones go into the message box, so you can add a line before sending.
struct ReviewCommentsSheet: View {
    @ObservedObject var sessions: SessionsModel
    let session: Sessions.Session

    var body: some View {
        if let sheet = sessions.reviewSheet {
            SessionSheet(
                title: "Review comments on PR #\(sheet.number)",
                lead: "\(sheet.threads.count == 1 ? "1 thread" : "\(sheet.threads.count) threads") on \(session.repo) · pulled just now",
                close: dismiss
            ) {
                ScrollView {
                    VStack(spacing: 6) {
                        ForEach(sheet.threads) { t in row(t, picked: sheet.picked.contains(t.id)) }
                        if sheet.threads.isEmpty {
                            Text("No review comments on this pull request yet.").font(Theme.sans(13)).foregroundStyle(Theme.textMuted)
                        }
                    }
                }
                .frame(maxHeight: 420)
            } buttons: {
                Button(sheet.picked.count == 1 ? "Add 1 comment to this chat" : "Add \(sheet.picked.count) comments to this chat") {
                    if let c = sessions.activeChat(of: session) { sessions.addReviewComments(to: c) }
                }
                .buttonStyle(ForgeButton(kind: .primary, large: true))
                .disabled(sheet.picked.isEmpty)
            }
        }
    }

    private func dismiss() { sessions.reviewSheet = nil }

    private func row(_ t: Sessions.ReviewThread, picked: Bool) -> some View {
        Button {
            guard var s = sessions.reviewSheet else { return }
            if picked { s.picked.remove(t.id) } else { s.picked.insert(t.id) }
            sessions.reviewSheet = s
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: picked ? "checkmark.square.fill" : "square").foregroundStyle(picked ? Theme.heat : Theme.textMuted)
                Initials(name: t.author, size: 24)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(t.place).font(Theme.mono(11)).foregroundStyle(Theme.textSec).lineLimit(1)
                        if t.outdated { Pill(text: "Outdated", tone: .ghost) }
                        if t.resolved { Pill(text: "Resolved", tone: .ghost) }
                    }
                    Text(t.body.split(separator: "\n").first.map(String.init) ?? "").font(Theme.sans(13)).foregroundStyle(Theme.text).lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            .padding(10)
            .opacity(t.resolved ? 0.55 : 1)
            .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(Theme.surface))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// "Bring your Conductor work over": Conductor's open workspaces by repo, each going into a Forge workspace. Conductor
/// stays as it is; every folder stays where it is.
struct ImportConductorSheet: View {
    @ObservedObject var model: AppModel
    @ObservedObject var sessions: SessionsModel
    let preview: Sessions.ConductorPreview
    @State private var picked: Set<String>

    init(model: AppModel, sessions: SessionsModel, preview: Sessions.ConductorPreview) {
        self.model = model
        self.sessions = sessions
        self.preview = preview
        _picked = State(initialValue: Self.initialPick(preview))
    }

    /// Everything not brought over yet starts picked; untick what to leave in Conductor.
    static func initialPick(_ p: Sessions.ConductorPreview) -> Set<String> {
        Set((p.workspaces ?? []).filter { !$0.imported }.map(\.id))
    }

    private var rows: [Sessions.ConductorWorkspace] { preview.workspaces ?? [] }
    private var repo: String { model.sessionRepos.first?.repo ?? "this workspace's repo" }
    private var open: [Sessions.ConductorWorkspace] { rows.filter { !$0.imported } }

    var body: some View {
        SessionSheet(
            title: "Bring your Conductor work over",
            lead: !preview.found
                ? "Forge didn't find Conductor on this Mac."
                : rows.isEmpty
                    ? "Conductor has no work on \(repo)."
                    : "Your Conductor workspaces on \(repo). Conductor stays as it is; Forge reads it and leaves every folder where it is.",
            close: dismiss
        ) {
            VStack(alignment: .leading, spacing: 0) {
                if !rows.isEmpty {
                    HStack(spacing: 10) {
                        toggle(on: !open.isEmpty && picked.count == open.count) {
                            picked = picked.count == open.count ? [] : Set(open.map(\.id))
                        }
                        .disabled(open.isEmpty)
                        SectionLabel(text: "Conductor workspace").frame(maxWidth: .infinity, alignment: .leading)
                        SectionLabel(text: "Chats").frame(width: 60, alignment: .trailing)
                    }
                    .padding(.bottom, 8)
                    ScrollView {
                        VStack(spacing: 0) {
                            ForEach(rows) { w in row(w) }
                        }
                    }
                    .frame(maxHeight: 320).fixedSize(horizontal: false, vertical: true)
                    Text(
                        "\(picked.count) of \(open.count) picked"
                            + (preview.alreadyImported > 0 ? " · \(preview.alreadyImported) already here" : "")
                    )
                    .font(Theme.sans(12)).foregroundStyle(Theme.textSec).padding(.top, 12)
                    Text("Don't send to the same chat from Conductor and Forge at once.").font(Theme.sans(11)).foregroundStyle(Theme.textMuted)
                        .padding(.top, 4)
                }
            }
        } buttons: {
            Button(sessions.busy ? "Importing…" : picked.isEmpty ? "Import selected" : "Import selected (\(picked.count))") {
                sessions.runImport(ids: rows.map(\.id).filter(picked.contains), workspace: model.workspace?.id ?? "default")
            }
            .buttonStyle(ForgeButton(kind: .primary, large: true))
            .disabled(picked.isEmpty || sessions.busy)
        }
    }

    private func row(_ w: Sessions.ConductorWorkspace) -> some View {
        let on = picked.contains(w.id)
        return HStack(spacing: 10) {
            toggle(on: on || w.imported) {
                if on { picked.remove(w.id) } else { picked.insert(w.id) }
            }
            .disabled(w.imported)
            VStack(alignment: .leading, spacing: 2) {
                Text(w.title).font(Theme.sans(13, .medium)).foregroundStyle(Theme.text).lineLimit(1)
                Text(w.imported ? "\(w.branch) · already here" : w.branch).font(Theme.mono(10)).foregroundStyle(Theme.textMuted).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Text("\(w.chats)").font(Theme.mono(12)).foregroundStyle(Theme.textSec).frame(width: 60, alignment: .trailing)
        }
        .opacity(w.imported ? 0.5 : 1)
        .frame(height: 44)
        .contentShape(Rectangle())
        .onTapGesture {
            guard !w.imported else { return }
            if on { picked.remove(w.id) } else { picked.insert(w.id) }
        }
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
    }

    private func toggle(on: Bool, _ flip: @escaping () -> Void) -> some View {
        Button(action: flip) {
            Image(systemName: on ? "checkmark.square.fill" : "square").font(.system(size: 14))
                .foregroundStyle(on ? Theme.heat : Theme.textMuted)
        }
        .buttonStyle(.plain)
    }

    private func dismiss() { sessions.importSheet = nil }
}
