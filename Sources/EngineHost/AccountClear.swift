import Foundation

/// Clearing an intelligence provider account: its sign-in or key leaves the Keychain and its own login folder
/// goes. Only what Forge made: an account carried over from before 0.2.17 that used this Mac's own Codex login has
/// no folder, so the person's own login stays exactly as it is.
enum AccountClear {
    /// The folder Forge may remove for this account: inside `Paths.accounts`, never anything else.
    static func ownFolder(_ a: AIAccount) -> URL? {
        guard let url = a.folderURL?.standardizedFileURL else { return nil }
        let root = Paths.accounts.standardizedFileURL.path + "/"
        return url.path.hasPrefix(root) && url.path.count > root.count ? url : nil
    }

    static func clear(_ a: AIAccount) async {
        if let folder = ownFolder(a), a.worker == .codex, FileManager.default.fileExists(atPath: folder.path) {
            // Codex may keep its sign-in in the Keychain under this folder's name: let it sign itself out first.
            _ = await Tools.run("codex", ["logout"], env: ["CODEX_HOME": folder.path], timeout: 20)
        }
        if let item = a.secretItem { Keychain.delete(named: item) }
        if let folder = ownFolder(a) { try? FileManager.default.removeItem(at: folder) }
    }
}
