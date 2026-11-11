import SwiftUI

/// Workspaces on the app's model: which one is on screen, switching between them and their projects, and the
/// tracker connections and GitHub accounts kept on this Mac. Running is per workspace (AppModel+Fleet.swift).
extension AppModel {
    /// The workspace on screen.
    var workspace: Workspace? { store.current }

    /// The workspace on screen runs.
    var running: Bool { workspace?.running == true }

    /// Points the tracker sign-ins at the running project's connection (on every change of `choices`), and GitHub
    /// at its account when a project opens (`github`; the GitHub step moves it itself while the person picks).
    func useSignIns(github: Bool = false) {
        guard !preview else { return }
        let item = store.trackerItem(choices)
        if choices.board == .basecamp { BasecampLogin.item = item }
        if choices.board == .github { GitHubLogin.item = item }
        if github { GitHub.account = choices.githubLogin }
    }

    /// Opens a workspace and one of its projects (nil = the one it showed last). Only the view changes: running
    /// workspaces keep running. The answers of the project left are kept; the one opened shows on the
    /// Orchestrator when it's set up, on the setup step that needs an answer otherwise.
    func open(workspace id: String, project: String? = nil) async {
        let old = viewedProject
        guard let next = store.switchTo(workspace: id, project: project, from: choices) else { return }
        choices = next
        engine = viewedProject.flatMap { states[$0] }
        engineProblem = viewedProject.flatMap { problems[$0] }
        boardLate = false
        // Setup changed for the project left while it runs: its engine takes the new answers now.
        if settingsChanged, !preview, let old, old != viewedProject, shouldRun(old), let l = links[old] { await l.connect(restart: true) }
        settingsChanged = false
        await leftProject(old)
        useSignIns(github: true)
        if !preview {
            choices.save()
            store.save()
        }
        returnTo = nil
        go(choices.nextScreen)
    }

    /// A new workspace, opened at once: setup starts on its tracker.
    func newWorkspace(name: String, color: String?) async {
        let w = store.addWorkspace(name: name, color: color)
        await open(workspace: w.id)
    }

    func renameWorkspace(_ name: String, color: String?) {
        guard let w = workspace else { return }
        store.rename(w.id, to: name, color: color)
        if !preview { store.save() }
    }

    /// Deletes a workspace (nil = the one on screen). Its engines stop; the one on screen switches away first, to a
    /// fresh empty workspace when it was the last; then its projects and their engine folders go. Sign-ins stay.
    func deleteWorkspace(_ id: String? = nil) async {
        guard let gone = id == nil ? workspace : store.workspace(id) else { return }
        let shown = gone.id == workspace?.id
        let mine = store.projects(in: gone.id)
        var keys = mine.map(\.id)
        if shown, !keys.contains(viewedProject ?? "") { keys.append(viewedProject ?? "") }
        store.setRunning(gone.id, false)
        for k in keys {
            await links[k]?.close()
            (links[k], states[k], problems[k]) = (nil, nil, nil)
        }
        if shown {
            // The engine just stopped must not restart with the answers left behind.
            settingsChanged = false
            let next = store.workspaceList.first { $0.id != gone.id } ?? store.addWorkspace(name: "My workspace", color: "heat")
            await open(workspace: next.id)
        }
        store.removeWorkspace(gone.id)
        guard !preview else { return }
        store.save()
        let (folders, root) = (mine.map(\.folder), Paths.home)
        await Task.detached { WorkspaceCleanup.remove(folders: folders, root: root) }.value
    }

    /// Cards of a workspace (nil = the one on screen) whose folders hold work that isn't pushed.
    func unpushedCards(in id: String? = nil) async -> Int {
        guard !preview, let w = id == nil ? workspace : store.workspace(id) else { return 0 }
        var hosts = store.projects(in: w.id).map { host(for: $0.id) }
        if w.id == workspace?.id, store.project(viewedProject) == nil { hosts.append(link.host) }
        var count = 0
        for h in hosts { count += await WorkspaceCleanup.unpushed(cards: h.cards) }
        return count
    }

    /// The delete sheet's paragraph: what goes, and, only when something would be lost, what.
    static func deleteLead(running: Int, unpushed: Int) -> String {
        let lead =
            "Forge forgets this workspace and the projects it manages, and clears their card folders on this Mac. "
            + "Your cards, repos and sign-ins stay; another workspace can use them."
        var lost: [String] = []
        if running > 0 { lost.append(running == 1 ? "1 card is being worked on" : "\(running) cards are being worked on") }
        if unpushed > 0 { lost.append(unpushed == 1 ? "1 card has work that isn't pushed" : "\(unpushed) cards have work that isn't pushed") }
        guard !lost.isEmpty else { return lead }
        return lead + "\n\n" + lost.joined(separator: " and ") + ". Deleting stops those agents and throws that work away."
    }

    /// The projects the workspace on screen manages, the one on screen first.
    var workspaceProjects: [ProjectRecord] {
        let all = store.projects(in: workspace?.id)
        let running = SetupStore.projectID(choices)
        return all.filter { $0.id == running } + all.filter { $0.id != running }
    }

    /// One line about a workspace: its projects, trackers and intelligence providers.
    func summary(_ w: Workspace) -> String {
        let ps = store.projects(in: w.id)
        guard !ps.isEmpty else { return "No projects yet" }
        let kinds = (w.connectionIDs ?? []).compactMap { store.connection($0)?.kind.name }
        var seen: [String] = []
        for k in kinds where !seen.contains(k) { seen.append(k) }
        var providers: [String] = []
        for p in ps { if let n = p.provider?.name, !providers.contains(n) { providers.append(n) } }
        let count = ps.count == 1 ? "1 project" : "\(ps.count) projects"
        return ([count] + [seen.joined(separator: ", "), providers.joined(separator: ", ")].filter { !$0.isEmpty }).joined(separator: " · ")
    }

    /// Keeps a new or changed tracker connection.
    func keep(connection t: TrackerRecord) {
        store.putConnection(t)
        if let w = workspace?.id { store.use(connection: t.id, in: w) }
        if !preview { store.save() }
        useSignIns()
    }

    /// Forgets a tracker connection no project uses, and its sign-in.
    func forget(connection t: TrackerRecord) {
        guard store.removeConnection(t.id) else { return }
        if !preview {
            Keychain.delete(named: t.item)
            store.save()
        }
    }

    /// Keeps a GitHub account Forge signed in to itself.
    func keep(github a: GitHubAccountRecord) {
        store.putGitHubAccount(a)
        if !preview { store.save() }
    }
}

extension AppModel {
    /// Render mode's workspaces: the sample project's, with a second Linear, a Basecamp and a GitHub Issues
    /// connection, a project ticked but not set up, and two more workspaces.
    static func sampleWorkspaces(_ s: inout SetupStore, _ c: SetupChoices) {
        s.upgrade(c, has: { $0 == TrackerItem.legacy(.linear) })
        let w = s.currentWorkspace ?? "ws-1"
        s.putConnection(TrackerRecord(id: "linear-p1", kind: .linear, org: "Sam's side work", user: "Sam Rivera", name: "Personal"))
        s.putConnection(
            TrackerRecord(id: "basecamp-ce", kind: .basecamp, org: "ConstructEase", user: "Sam Rivera", accountID: "1", personID: "2"))
        s.putConnection(TrackerRecord(id: "github-sr", kind: .github, org: "@samrivera", user: "Sam Rivera", login: "samrivera"))
        s.use(connection: "github-sr", in: w)
        s.projects.append(
            ProjectRecord(
                id: "linear:website", trackerID: "linear", name: "Website", workspaceID: w,
                ref: ProjectRef(team: "t1", projectID: "p2", slug: "website")))
        s.projects.append(
            ProjectRecord(id: "github-sr:PVT_1", trackerID: "github-sr", name: "ai-trading-bot board", repo: "acme/ai-trading-bot", workspaceID: w))
        let ff = s.addWorkspace(name: "Forge Factory", color: "cream")
        s.use(connection: "basecamp-ce", in: ff.id)
        s.projects.append(
            ProjectRecord(id: "basecamp-ce:4666", trackerID: "basecamp-ce", name: "Dev Chat", repo: "acme/dev-chat", workspaceID: ff.id))
        s.addWorkspace(name: "Side projects", color: "green")
        s.githubAccounts = [GitHubAccountRecord(login: "samrivera-work", name: "Sam Rivera")]
    }
}

/// The app's model for the pieces every screen shares (the top bar's workspace chip), without passing it down.
private struct ForgeModelKey: EnvironmentKey {
    static let defaultValue: AppModel? = nil
}

extension EnvironmentValues {
    var forgeModel: AppModel? {
        get { self[ForgeModelKey.self] }
        set { self[ForgeModelKey.self] = newValue }
    }
}
