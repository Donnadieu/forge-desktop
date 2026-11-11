import SwiftUI

/// New session: the workspace's repo (locked to it), the branch (a new one off main by default, named by Forge or by
/// the person, or an existing one), the first message, the model, Send. Send makes the session's own folder (a git
/// worktree) on that branch, so sessions never collide, then starts the first chat.
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
    @State private var existing = false
    @State private var branchName = ""
    @State private var branchPick: String?
    @State private var branchList: [String] = []
    @State private var loadingBranches = false

    private var repos: [SessionRepo] { model.sessionRepos }
    private var picked: SessionRepo? { repos.first { $0.repo == repo } ?? repos.first }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer(minLength: 24)
            SectionLabel(text: "New session · \(model.workspace?.name ?? "workspace")")
            Text("What should we build?").font(Theme.display(40)).foregroundStyle(Theme.text).padding(.top, 8)
            HStack(spacing: 8) {
                repoMenu
                Segmented(options: [(false, "New branch"), (true, "Existing branch")], selection: $existing).frame(width: 250)
                if existing { existingMenu } else { newBranch }
                Spacer()
                if !sessions.sessions.isEmpty, sessions.current != nil {
                    Button("Back to the chat") { sessions.composing = false }.buttonStyle(ForgeButton(kind: .ghost))
                }
            }
            .padding(.top, 20)
            if adding { addRow.padding(.top, 8) }
            box.padding(.top, 20)
            Text(footnote)
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

    private var footnote: String {
        let from = picked?.local != nil ? "your checkout in \(picked?.local ?? "")" : "a fresh copy of the repo"
        if existing {
            return "Send opens \(branchPick ?? "the branch") in its own folder from \(from), then starts the first chat."
        }
        let name = branchName.trimmingCharacters(in: .whitespaces)
        return "Send makes its own folder from \(from) on a new branch \(name.isEmpty ? "" : "\(name) ")off \(base.isEmpty ? "main" : base), "
            + "so it never touches another session's work, then starts the first chat."
    }

    /// The workspace's repo, locked to it. A workspace with no repo yet can add one here.
    @ViewBuilder private var repoMenu: some View {
        if repos.count > 1 {
            Menu {
                ForEach(repos) { r in Button(r.repo) { pick(r) } }
            } label: {
                Label(picked?.repo ?? "Pick a repo", systemImage: "lock").font(Theme.mono(12)).foregroundStyle(Theme.text)
            }
            .menuStyle(.borderlessButton).fixedSize()
            .modifier(Field())
        } else if let r = picked {
            Label(r.repo, systemImage: "lock").font(Theme.mono(12)).foregroundStyle(Theme.text).fixedSize().modifier(Field())
                .help("This workspace's sessions work on its repo")
        } else {
            Button("Add the repo…") { adding = true }.buttonStyle(ForgeButton(kind: .secondary, icon: "folder", large: true))
        }
    }

    private var newBranch: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.triangle.branch").font(.system(size: 11)).foregroundStyle(Theme.textMuted)
            TextField("", text: $branchName).textFieldStyle(.plain).font(Theme.mono(12)).foregroundStyle(Theme.text).frame(width: 150)
                .background(alignment: .leading) {
                    if branchName.isEmpty {
                        Text("name it (optional)").font(Theme.mono(12)).foregroundStyle(Theme.textMuted).allowsHitTesting(false)
                    }
                }
            Text(verbatim: "off").font(Theme.sans(12)).foregroundStyle(Theme.textSec).fixedSize()
            TextField("", text: $base).textFieldStyle(.plain).font(Theme.mono(12)).foregroundStyle(Theme.text).frame(width: 70)
        }
        .modifier(Field())
    }

    private var existingMenu: some View {
        Menu {
            if branchList.isEmpty {
                Text(loadingBranches ? "Reading the branches…" : "No branches found")
            }
            ForEach(branchList, id: \.self) { b in Button(b) { branchPick = b } }
        } label: {
            Label(branchPick ?? (loadingBranches ? "Reading the branches…" : "Pick a branch"), systemImage: "arrow.triangle.branch")
                .font(Theme.mono(12)).foregroundStyle(Theme.text)
        }
        .menuStyle(.borderlessButton).fixedSize()
        .modifier(Field())
        .task(id: picked?.repo) { await loadBranches() }
    }

    private func loadBranches() async {
        guard let r = picked else { return }
        loadingBranches = true
        branchList = await sessions.branches(of: r)
        loadingBranches = false
    }

    private struct Field: ViewModifier {
        func body(content: Content) -> some View {
            content
                .padding(.horizontal, 12).frame(height: 34)
                .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(Theme.surface))
                .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.border))
        }
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
                    .disabled(
                        sessions.busy || picked == nil || (existing && branchPick == nil)
                            || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
        let branch: SessionsModel.BranchChoice = existing ? .existing(branchPick ?? "") : .new(branchName)
        sessions.create(workspace: model.workspace?.id ?? "default", repo: r, message: message, model: m, effort: e, branch: branch) { ok in
            if ok {
                message = ""
                branchName = ""
            }
        }
    }
}
