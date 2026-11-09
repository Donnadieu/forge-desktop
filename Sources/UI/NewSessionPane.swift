import SwiftUI

/// New session: pick the repo and the branch to start from, write the first message, pick the model, Send. Send
/// makes the session's own folder and branch, then starts the first chat.
struct NewSessionPane: View {
    @ObservedObject var model: AppModel
    @ObservedObject var sessions: SessionsModel
    @State private var repo: String?
    @State private var base = ""
    @State private var message = ""
    @State private var chatModel: String?
    @State private var effort: String?
    @State private var adding = false
    @State private var newRepo = ""

    private var repos: [SessionRepo] { model.sessionRepos }
    private var picked: SessionRepo? { repos.first { $0.repo == repo } ?? repos.first }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer(minLength: 24)
            SectionLabel(text: "New session · \(model.workspace?.name ?? "workspace")")
            Text("What should we build?").font(Theme.display(40)).foregroundStyle(Theme.text).padding(.top, 8)
            HStack(spacing: 8) {
                repoMenu
                baseMenu
                Spacer()
                if !sessions.sessions.isEmpty, sessions.current != nil {
                    Button("Back to the chat") { sessions.composing = false }.buttonStyle(ForgeButton(kind: .ghost))
                }
            }
            .padding(.top, 20)
            if adding { addRow.padding(.top, 8) }
            box.padding(.top, 20)
            Text(
                picked?.local != nil
                    ? "Send makes a folder and branch from your checkout in \(picked?.local ?? ""), then starts the first chat."
                    : "Send makes a folder and branch for this session, then starts the first chat."
            )
            .font(Theme.sans(12)).foregroundStyle(Theme.textMuted).padding(.top, 12)
            if let p = sessions.problem { Notice(title: p).padding(.top, 12) }
            Spacer(minLength: 24)
        }
        .frame(maxWidth: 640)
        .padding(.horizontal, 40)
        .frame(maxWidth: .infinity)
        .onAppear {
            if repo == nil { repo = repos.first?.repo }
            if base.isEmpty { base = picked?.base ?? "main" }
        }
    }

    private var repoMenu: some View {
        Menu {
            ForEach(repos) { r in Button(r.repo) { pick(r) } }
            Divider()
            Button("Add a repo…") { adding = true }
        } label: {
            Label(picked?.repo ?? "Pick a repo", systemImage: "folder").font(Theme.mono(12)).foregroundStyle(Theme.text)
        }
        .menuStyle(.borderlessButton).fixedSize()
        .padding(.horizontal, 12).frame(height: 34)
        .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.border))
    }

    private var baseMenu: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.triangle.branch").font(.system(size: 11)).foregroundStyle(Theme.textMuted)
            Text("Branch from").font(Theme.sans(12)).foregroundStyle(Theme.textSec)
            TextField("", text: $base).textFieldStyle(.plain).font(Theme.mono(12)).foregroundStyle(Theme.text).frame(width: 90)
        }
        .padding(.horizontal, 12).frame(height: 34)
        .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.border))
    }

    private var addRow: some View {
        HStack(spacing: 8) {
            TextField("", text: $newRepo).forgeField(mono: true, hint: "owner/name", empty: newRepo.isEmpty)
            Button("Add") {
                let r = newRepo.trimmingCharacters(in: .whitespaces)
                guard r.split(separator: "/").count == 2 else { return }
                let rec = SessionRepo(repo: r, local: AppModel.localCheckout(r), base: "main")
                model.addSessionRepo(rec)
                pick(rec)
                adding = false
                newRepo = ""
            }
            .buttonStyle(ForgeButton(kind: .secondary, large: true))
            Button("Cancel") { adding = false }.buttonStyle(ForgeButton(kind: .ghost, large: true))
        }
    }

    private var box: some View {
        VStack(alignment: .leading, spacing: 12) {
            ZStack(alignment: .topLeading) {
                if message.isEmpty {
                    Text("Message the agent…").font(Theme.sans(14)).foregroundStyle(Theme.textMuted).padding(.top, 1).padding(.leading, 5)
                }
                TextEditor(text: $message).font(Theme.sans(14)).foregroundStyle(Theme.text).scrollContentBackground(.hidden)
                    .frame(minHeight: 110, maxHeight: 260)
            }
            HStack(spacing: 8) {
                Spacer()
                ModelChip(
                    model: chatModel ?? model.sessionModel, effort: effort ?? model.sessionEffort,
                    pick: { m, e in (chatModel, effort) = (m, e) })
                Button(sessions.busy ? "Making the folder…" : "Send") { send() }
                    .buttonStyle(ForgeButton(kind: .primary, hint: "⌘↵", icon: "paperplane", large: true))
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(sessions.busy || picked == nil || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: Theme.rLg).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: Theme.rLg).stroke(Theme.border))
    }

    private func pick(_ r: SessionRepo) {
        repo = r.repo
        base = r.base ?? "main"
    }

    private func send() {
        guard var r = picked else { return }
        r.base = base.isEmpty ? "main" : base
        let m = chatModel ?? model.sessionModel
        let e = effort ?? model.sessionEffort
        model.keepSessionDefaults(model: m, effort: e)
        sessions.create(workspace: model.workspace?.id ?? "default", repo: r, message: message, model: m, effort: e) { ok in
            if ok { message = "" }
        }
    }
}
