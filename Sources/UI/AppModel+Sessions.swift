import Foundation

/// What the Sessions screen needs from the workspace on screen: the repos its sessions can work on and the model a
/// new chat starts with.
extension AppModel {
    /// The workspace's own repos, then its projects' repos, each once; a checkout in ~/Repos is found by itself.
    var sessionRepos: [SessionRepo] {
        var out = workspace?.repos ?? []
        for p in workspaceProjects {
            guard let r = p.repo, !out.contains(where: { $0.repo.lowercased() == r.lowercased() }) else { continue }
            out.append(SessionRepo(repo: r, local: Self.localCheckout(r), base: p.defaultBranch ?? "main"))
        }
        return out
    }

    /// `~/Repos/<name>` when it's a checkout of that repo (its origin names it).
    static func localCheckout(_ repo: String) -> String? {
        guard let name = repo.split(separator: "/").last else { return nil }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let dir = home.appendingPathComponent("Repos").appendingPathComponent(String(name))
        let config = dir.appendingPathComponent(".git/config")
        guard let text = try? String(contentsOf: config, encoding: .utf8), text.lowercased().contains(repo.lowercased()) else { return nil }
        return dir.path
    }

    /// Adds a repo to the workspace on screen (from New session's repo menu).
    func addSessionRepo(_ r: SessionRepo) {
        guard let w = workspace?.id, let i = store.workspaces?.firstIndex(where: { $0.id == w }) else { return }
        var repos = store.workspaces?[i].repos ?? []
        repos.removeAll { $0.repo.lowercased() == r.repo.lowercased() }
        repos.append(r)
        store.workspaces?[i].repos = repos
        if !preview { store.save() }
    }

    var sessionModel: String { workspace?.sessionModel ?? Sessions.defaultModel }
    var sessionEffort: String { workspace?.sessionEffort ?? Sessions.defaultEffort }

    /// Remembers the model and effort a new session was started with, for the next one.
    func keepSessionDefaults(model: String, effort: String) {
        guard let w = workspace?.id, let i = store.workspaces?.firstIndex(where: { $0.id == w }) else { return }
        store.workspaces?[i].sessionModel = model
        store.workspaces?[i].sessionEffort = effort
        if !preview { store.save() }
    }
}
