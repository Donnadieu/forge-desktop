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
            TextField("", text: $filter)
                .forgeField(hint: "Search your repos", empty: filter.isEmpty)
                .frame(maxWidth: 520)
                .padding(.bottom, 10)
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(shown.enumerated()), id: \.element.fullName) { i, r in
                        let on = selected == r.fullName
                        if i > 0 { Rectangle().fill(Theme.hairline).frame(height: 1) }
                        HStack(spacing: 10) {
                            Image(systemName: "folder").font(.system(size: 12)).foregroundStyle(on ? Theme.heatBright : Theme.textMuted)
                            Text(r.fullName).font(Theme.mono(13)).foregroundStyle(on ? Theme.text : Theme.textSec)
                            Spacer()
                            if !r.canPush { Chip(text: "Read only") }
                            if on { Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.heatBright) }
                        }
                        .padding(.horizontal, 14)
                        .frame(height: 38)
                        .background(on ? Theme.heat.opacity(0.10) : .clear)
                        .contentShape(Rectangle())
                        .onTapGesture { selected = r.fullName }
                    }
                }
            }
            .frame(maxWidth: 520, minHeight: 120, maxHeight: 240)
            .fixedSize(horizontal: false, vertical: true)
            .panel()
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
