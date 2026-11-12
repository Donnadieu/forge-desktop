import Foundation

/// Workspace setup on the app's side: saving the screen's answers (secrets into the Keychain), the variables a
/// session's agents and terminals get, telling the sessions host (in memory only), and the notifications switch.
extension AppModel {
    /// Secrets live in the Keychain; screen renders and checks never touch it.
    var secretStore: SecretStore { preview ? MemorySecrets() : KeychainSecrets() }

    /// What a session terminal starts with: the same variables as the workspace's chats (its own and its account's
    /// sign-in), secrets read back from the Keychain.
    func sessionEnv(_ workspaceID: String) -> [String: String] {
        guard let w = store.workspace(workspaceID) ?? store.current else { return [:] }
        return sessionPayload(w.id)["env"] as? [String: String] ?? [:]
    }

    /// What the sessions host gets for one workspace: its copy list, scripts, variables and the sign-in of the account
    /// its chats run on (`WorkerCheck.sessionEnv`), with which values are secret.
    func sessionPayload(_ workspaceID: String) -> [String: Any] {
        let base = (store.workspace(workspaceID)?.setup ?? WorkspaceSetup()).payload(workspace: workspaceID, secrets: secretStore)
        return WorkspaceSetup.withAccount(base, WorkerCheck.sessionEnv(store, workspace: workspaceID, secret: accountSecret))
    }

    /// What the sessions host gets for every workspace.
    func setupPayloads() -> [String: [String: Any]] {
        var out: [String: [String: Any]] = [:]
        for w in store.workspaceList { out[w.id] = sessionPayload(w.id) }
        return out
    }

    /// Saves the Workspace setup screen for the workspace on screen. New sessions and terminals use it at once; the
    /// card engines restart with the new variables when the Orchestrator opens again.
    func saveWorkspaceSetup(copy: [String], setupScript: String, cleanupScript: String, rows: [EnvRow]) {
        guard let w = workspace, let i = store.workspaces?.firstIndex(where: { $0.id == w.id }) else { return }
        let old = w.setup ?? WorkspaceSetup()
        let env = WorkspaceEnv.save(rows, workspace: w.id, old: old.env ?? [], secrets: secretStore)
        var seen = Set<String>()
        let files = copy.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty && seen.insert($0).inserted }
        let next = WorkspaceSetup(
            copy: files, setupScript: setupScript.isBlank ? nil : setupScript, cleanupScript: cleanupScript.isBlank ? nil : cleanupScript,
            env: env)
        store.workspaces?[i].setup = next.isEmpty ? nil : next
        if !preview { store.save() }
        if old.env ?? [] != env || rows.contains(where: { $0.secret && !$0.value.isEmpty }) { settingsChanged = true }
        sessions.pushSetup(w.id, sessionPayload(w.id))
    }

    /// The one notifications switch, on this Mac.
    func setAgentNotifications(_ on: Bool) {
        store.agentNotifications = on ? nil : false
        if !preview { store.save() }
        objectWillChange.send()
    }

    /// Wires the sessions host's setup and the notifications switch to the store.
    func connectWorkspaceSetup() {
        sessions.setups = { [weak self] in self?.setupPayloads() ?? [:] }
        AgentNotifier.shared.enabled = { [weak self] in self?.store.agentNotificationsOn ?? true }
    }

    /// The files git ignores in this workspace's checkouts, for "Add from repo".
    func ignoredFiles() async -> [(repo: String, paths: [String])] {
        var out: [(String, [String])] = []
        for r in workspace?.repos ?? [] {
            guard let local = r.local else { continue }
            out.append((r.repo, await WorkspaceSetupReader.ignored(in: local)))
        }
        return out
    }
}

extension SessionsModel {
    /// Tells the host one workspace's setup (on Save).
    func pushSetup(_ workspace: String, _ body: [String: Any]) {
        act { try await $0.workspaceSetup(workspace, body) }
    }
}
