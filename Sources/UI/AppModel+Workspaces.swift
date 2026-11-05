import SwiftUI

/// Workspaces on the app's model: which one is on screen, switching between them and their projects, and the
/// tracker connections and GitHub accounts kept on this Mac. One project runs at a time for now.
extension AppModel {
    /// The workspace on screen.
    var workspace: Workspace? { store.current }

    /// The engine is working the running project's cards.
    var running: Bool { engine?.isRunning == true }

    /// Points the tracker sign-ins at the running project's connection (on every change of `choices`), and GitHub
    /// at its account when a project opens (`github`; the GitHub step moves it itself while the person picks).
    func useSignIns(github: Bool = false) {
        guard !preview else { return }
        let item = store.trackerItem(choices)
        if choices.board == .basecamp { BasecampLogin.item = item }
        if choices.board == .github { GitHubLogin.item = item }
        if github { GitHub.account = choices.githubLogin }
    }

    /// Opens a workspace and one of its projects (nil = the one it ran last). The engine stops first (running
    /// agents get their usual time to finish), the running project's answers are kept, and the other project
    /// opens stopped: on the Orchestrator when it's set up, on the setup step that needs an answer otherwise.
    func open(workspace id: String, project: String? = nil) async {
        if !preview {
            if running {
                await link.stop()
                // The engine didn't say it stopped: switching now could start the other project's agents. Its
                // problem line says to press Stop again.
                if engineProblem != nil { return }
            }
            await EngineHost.shared.stop()
        }
        engine = nil
        engineProblem = nil
        guard let next = store.switchTo(workspace: id, project: project, from: choices) else { return }
        choices = next
        useSignIns(github: true)
        settingsChanged = true
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

    /// Forgets the workspace on screen and opens another; sign-ins stay on the Mac.
    func deleteWorkspace() async {
        guard let gone = workspace, let other = store.workspaceList.first(where: { $0.id != gone.id }) else { return }
        await open(workspace: other.id)
        store.removeWorkspace(gone.id)
        if !preview { store.save() }
    }

    /// The projects the workspace on screen manages, the running one first.
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
