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
    @State private var targets: [String: String] = [:]

    private var workspaces: [Workspace] { model.store.workspaceList }

    var body: some View {
        SessionSheet(
            title: "Bring your Conductor work over",
            lead: preview.found
                ? "Conductor stays as it is. Forge reads it and leaves every folder where it is."
                : "Forge didn't find Conductor on this Mac.",
            close: dismiss
        ) {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    SectionLabel(text: "Repo").frame(maxWidth: .infinity, alignment: .leading)
                    SectionLabel(text: "Sessions").frame(width: 70, alignment: .trailing)
                    SectionLabel(text: "Chats").frame(width: 60, alignment: .trailing)
                    SectionLabel(text: "Into workspace").frame(width: 170, alignment: .leading).padding(.leading, 16)
                }
                .padding(.bottom, 8)
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(preview.repos) { r in
                            HStack {
                                Text(r.repo).font(Theme.mono(12)).foregroundStyle(Theme.text).lineLimit(1).frame(
                                    maxWidth: .infinity, alignment: .leading)
                                Text("\(r.sessions)").font(Theme.mono(12)).frame(width: 70, alignment: .trailing)
                                Text("\(r.chats)").font(Theme.mono(12)).frame(width: 60, alignment: .trailing)
                                Picker("", selection: binding(r.repo)) {
                                    ForEach(workspaces) { w in Text(w.name).tag(w.id) }
                                }
                                .labelsHidden().frame(width: 170).padding(.leading, 16)
                            }
                            .foregroundStyle(Theme.textSec)
                            .frame(height: 36)
                            .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
                        }
                    }
                }
                .frame(maxHeight: 300)
                Text("\(preview.repos.count) repos · \(preview.chats) chats · \(preview.messages.formatted()) messages")
                    .font(Theme.sans(12)).foregroundStyle(Theme.textSec).padding(.top, 12)
                if preview.alreadyImported > 0 {
                    Text("\(preview.alreadyImported) already here; they're left as they are.").font(Theme.sans(11)).foregroundStyle(Theme.textMuted)
                }
                Text("Don't send to the same chat from Conductor and Forge at once.").font(Theme.sans(11)).foregroundStyle(Theme.textMuted).padding(
                    .top, 4)
            }
        } buttons: {
            Button(sessions.busy ? "Importing…" : "Import \(preview.sessions) sessions") {
                sessions.runImport(targets: targets, workspace: model.workspace?.id ?? "default")
            }
            .buttonStyle(ForgeButton(kind: .primary, large: true))
            .disabled(preview.sessions == 0 || sessions.busy)
        }
    }

    private func dismiss() { sessions.importSheet = nil }

    private func binding(_ repo: String) -> Binding<String> {
        Binding(get: { targets[repo] ?? model.workspace?.id ?? workspaces.first?.id ?? "default" }, set: { targets[repo] = $0 })
    }
}
