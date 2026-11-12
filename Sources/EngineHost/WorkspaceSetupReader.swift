import Foundation

/// Reads what the Workspace setup screen offers: the files and folders git ignores in the workspace's checkouts
/// (for "Add from repo"). Here because only EngineHost starts programs.
enum WorkspaceSetupReader {
    /// What git ignores at the top of a checkout, folders as `dir/`, sorted. Nested build output (node_modules
    /// deep inside) shows once as its top folder, since git lists ignored folders whole.
    static func ignored(in checkout: String) async -> [String] {
        let r = await Tools.run(
            "git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"],
            cwd: URL(fileURLWithPath: checkout), timeout: 20)
        return r.ok ? parseIgnored(r.out) : []
    }

    static func parseIgnored(_ out: String) -> [String] {
        Array(Set(out.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })).sorted()
    }
}

extension EngineSettings {
    /// A card engine's environment with the workspace's variables added; Forge's own variables win, so a workspace
    /// can't change how the engine signs in or pushes.
    static func withWorkspaceEnv(_ forge: [String: String], _ workspace: [String: String]) -> [String: String] {
        forge.merging(workspace) { mine, _ in mine }
    }

    /// The variables of the workspace that runs this project, secrets read from the Keychain.
    static func workspaceEnv(_ c: SetupChoices, store: SetupStore) -> [String: String] {
        let w = SetupStore.projectID(c).flatMap { store.owner(of: $0) } ?? store.current
        guard let w, let vars = w.setup?.env, !vars.isEmpty else { return [:] }
        return WorkspaceEnv.values(vars, workspace: w.id, secrets: KeychainSecrets())
    }
}
