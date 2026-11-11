import Foundation

/// Import from Conductor: what it holds for the workspace's repo, and bringing the picked workspaces over.
extension SessionsModel {
    /// Opens the import sheet with what Conductor holds for the workspace's repo.
    func openImport(repo: String?) {
        guard let client else { return }
        Task {
            do { importSheet = try await client.conductor(repo: repo) } catch { problem = "\(error)" }
        }
    }

    static func importBody(ids: [String], workspace: String) -> [String: Any] { ["ids": ids, "workspace": workspace] }

    /// Brings the picked Conductor workspaces into this workspace.
    func runImport(ids: [String], workspace: String) {
        guard let client, !ids.isEmpty else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await client.importConductor(Self.importBody(ids: ids, workspace: workspace))
                importSheet = nil
                sessions = (try? await client.sessions()) ?? sessions
            } catch { problem = "\(error)" }
        }
    }
}
