import SwiftUI

/// Setup 4: pick the repo from your GitHub. Forge checks you can push to it before you can go on.
struct RepoScreen: View {
    @ObservedObject var model: AppModel
    @State private var repos: [GitHub.Repo] = []
    @State private var filter = ""
    @State private var selected: String?
    @State private var pushOK: Bool?
    @State private var busy = false

    private var shown: [GitHub.Repo] {
        let f = filter.trimmingCharacters(in: .whitespaces).lowercased()
        return f.isEmpty ? repos : repos.filter { $0.fullName.lowercased().contains(f) }
    }

    var body: some View {
        SetupFrame(
            model: model,
            question: "Which repo do the cards change?",
            detail: "Agents clone it, work on a branch per card and open pull requests against its main branch.",
            primary: "Continue",
            primaryEnabled: pushOK == true,
            busy: busy,
            action: finish
        ) {
            TextField("Search your repos", text: $filter)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 420)
                .padding(.bottom, 8)
            List(shown, selection: $selected) { r in
                HStack {
                    Text(r.fullName).font(.system(size: 13))
                    Spacer()
                    if !r.canPush { Text("read only").font(.system(size: 11)).foregroundStyle(.secondary) }
                }
                .tag(r.fullName)
            }
            .frame(maxWidth: 520, minHeight: 180, maxHeight: 240)
            if let s = selected, let ok = pushOK {
                Group {
                    if ok {
                        GoodLine(text: "You can push to \(s).")
                    } else {
                        ProblemLine(text: "GitHub says you can't push to \(s). Pick a repo you can push to.")
                    }
                }
                .padding(.top, 10)
            }
        }
        .task { await load() }
        .onChange(of: selected) { _, s in Task { await check(s) } }
    }

    private func load() async {
        if model.preview {
            repos = model.sample.repos
            selected = repos.first?.fullName
            pushOK = true
            return
        }
        busy = true
        repos = await GitHub.repos()
        busy = false
        if let r = model.choices.repo { selected = r }
    }

    private func check(_ repo: String?) async {
        pushOK = nil
        if model.preview {
            pushOK = true
            return
        }
        guard let repo else { return }
        busy = true
        pushOK = await GitHub.canPush(repo)
        busy = false
    }

    private func finish() {
        guard let s = selected, let r = repos.first(where: { $0.fullName == s }) else { return }
        model.choices.repo = r.fullName
        model.choices.defaultBranch = r.defaultBranch
        model.choices.repoChecked = true
        model.next()
    }
}
