import SwiftUI

/// Setup 4: pick the repo from your GitHub. Forge checks you can push to it before you can go on. A GitHub Issues
/// project is one-to-one with its repo: the repo its issues live in is the one the cards change, locked here.
struct RepoScreen: View {
    @ObservedObject var model: AppModel
    @State private var repos: [GitHub.Repo] = []
    @State private var filter = ""
    @State private var selected: String?
    @State private var pushOK: Bool?
    @State private var busy = false
    /// The workspace's name, suggested until the person types one (`suggested` = what Forge last put there).
    @State private var name = ""
    @State private var suggested = ""

    /// The repo a GitHub Issues board files its issues in: the only one its cards may change.
    private var locked: String? { Self.lockedRepo(model.choices) }

    static func lockedRepo(_ c: SetupChoices) -> String? { c.board == .github ? c.githubBoard?.issueRepo : nil }

    private var shown: [GitHub.Repo] {
        if let locked { return repos.filter { $0.fullName.lowercased() == locked.lowercased() } }
        let f = filter.trimmingCharacters(in: .whitespaces).lowercased()
        return f.isEmpty ? repos : repos.filter { $0.fullName.lowercased().contains(f) }
    }

    var body: some View {
        SetupFrame(
            model: model,
            question: "Which repo do the cards change?",
            detail: locked.map {
                "Your GitHub Issues board's issues live in \($0), so its cards change the same repo. Agents clone it, work on a branch per card and open pull requests against its main branch."
            }
                ?? "Agents clone it, work on a branch per card and open pull requests against its main branch.",
            primary: "Continue",
            primaryEnabled: pushOK == true,
            busy: busy,
            action: finish
        ) {
            if locked == nil {
                TextField("", text: $filter)
                    .forgeField(hint: "Search your repos", empty: filter.isEmpty)
                    .frame(maxWidth: 520)
                    .padding(.bottom, 10)
            }
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(shown.enumerated()), id: \.element.fullName) { i, r in
                        let on = selected == r.fullName
                        if i > 0 { Rectangle().fill(Theme.border).frame(height: 1) }
                        HStack(spacing: 10) {
                            Image(systemName: "folder").font(.system(size: 12)).foregroundStyle(on ? Theme.heatBright : Theme.textMuted)
                            Text(r.fullName).font(Theme.mono(13)).foregroundStyle(on ? Theme.text : Theme.textSec)
                            Spacer()
                            if !r.canPush { Chip(text: "Read only") }
                            if locked != nil { Image(systemName: "lock.fill").font(.system(size: 10)).foregroundStyle(Theme.textMuted) }
                            if on { Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.heatBright) }
                        }
                        .padding(.horizontal, 14)
                        .frame(height: 38)
                        .background(on ? Theme.heat.opacity(0.10) : .clear)
                        .contentShape(Rectangle())
                        .onTapGesture { if locked == nil { selected = r.fullName } }
                    }
                }
            }
            .frame(maxWidth: 520, minHeight: 120, maxHeight: 240)
            .fixedSize(horizontal: false, vertical: true)
            .panel()
            if let locked, !busy, !repos.isEmpty, shown.isEmpty {
                ProblemLine(text: "Forge can't see \(locked) with your GitHub account. Pick the GitHub account that can push to it.")
                    .padding(.top, 10)
            }
            VStack(alignment: .leading, spacing: 6) {
                SectionLabel(text: "Workspace name")
                TextField("", text: $name)
                    .forgeField(hint: "My workspace", empty: name.isEmpty)
                    .frame(maxWidth: 520)
            }
            .padding(.top, 18)
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
        .onChange(of: selected) { _, s in
            if name == suggested { (name, suggested) = (suggestion(s), suggestion(s)) }
            Task { await check(s) }
        }
    }

    private func suggestion(_ repo: String?) -> String {
        Self.suggestedName(current: model.workspace?.name, repo: repo, choices: model.choices)
    }

    private func load() async {
        if name.isEmpty { (name, suggested) = (suggestion(selected), suggestion(selected)) }
        if model.preview {
            repos = model.sample.repos
            selected = locked ?? repos.first?.fullName
            pushOK = true
            return
        }
        busy = true
        repos = await GitHub.repos()
        busy = false
        if let locked {
            selected = repos.first { $0.fullName.lowercased() == locked.lowercased() }?.fullName
        } else if let r = model.choices.repo {
            selected = r
        }
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
        Self.apply(repo: r, name: name, to: model)
    }

    /// The name setup suggests for the workspace: its own name if it has one, else the repo's, else the team's
    /// (or project's), else "My workspace".
    static func suggestedName(current: String?, repo: String?, choices: SetupChoices) -> String {
        let plain = "My workspace"
        if let current, !current.trimmingCharacters(in: .whitespaces).isEmpty, current != plain { return current }
        let candidates = [repo.flatMap { $0.split(separator: "/").last.map(String.init) }, choices.teamName, choices.projectName]
        return candidates.compactMap { $0 }.first { !$0.isEmpty } ?? plain
    }

    /// Continue: keeps the repo and the workspace's name, then moves on.
    static func apply(repo r: GitHub.Repo, name: String, to model: AppModel) {
        let typed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !typed.isEmpty, typed != model.workspace?.name { model.renameWorkspace(typed, color: model.workspace?.color) }
        let old = model.choices.repo
        model.choices.repo = r.fullName
        model.choices.defaultBranch = r.defaultBranch
        model.choices.repoChecked = true
        guard let step = AppModel.afterRepo(changing: model.changing, old: old, new: r.fullName) else { return model.next() }
        // A new repo, changed from Settings: offer to get it ready for agents before going back.
        model.save()
        model.go(step)
        model.harnessOffer = r.fullName
    }
}
