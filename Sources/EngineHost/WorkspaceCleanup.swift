import Foundation

/// What deleting a workspace leaves behind: its cards' unpushed work (asked about first), then its projects' engine
/// folders and their shared agent-slot files.
enum WorkspaceCleanup {
    /// How many card folders under `cards` hold work that isn't pushed: uncommitted changes, or commits no remote has.
    /// Forge's own files in a card folder are in its local git exclude list, so they never count.
    static func unpushed(cards: URL) async -> Int {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: cards.path) else { return 0 }
        var count = 0
        for name in names.sorted() {
            let dir = cards.appendingPathComponent(name)
            guard fm.fileExists(atPath: dir.appendingPathComponent(".git").path) else { continue }
            let changes = await Tools.run("git", ["status", "--porcelain"], cwd: dir, timeout: 20)
            let local = await Tools.run("git", ["log", "--branches", "--not", "--remotes", "--oneline", "-1"], cwd: dir, timeout: 20)
            if !changes.out.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || !local.out.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
                count += 1
            }
        }
        return count
    }

    /// Removes the engine folders (`ProjectRecord.folder`) under `root` and their files in `root/slots`. Only plain
    /// `projects/<name>` folders: nil (the project kept in Forge's own folder) and anything else are left alone.
    static func remove(folders: [String?], root: URL) {
        let fm = FileManager.default
        for case let folder? in folders {
            let parts = folder.split(separator: "/", omittingEmptySubsequences: false)
            guard parts.count == 2, parts[0] == "projects", !parts[1].isEmpty, parts[1] != ".", parts[1] != ".." else { continue }
            let home = root.appendingPathComponent(folder)
            try? fm.removeItem(at: home)
            try? fm.removeItem(at: root.appendingPathComponent("slots").appendingPathComponent(slotFile(home)))
        }
    }

    /// An engine's file in the shared slots folder: engine orchestrator/shared-slots.ts names it after the engine's
    /// folder, with anything but letters, digits, `_`, `.` and `-` made `_`.
    static func slotFile(_ home: URL) -> String {
        let safe = home.path.unicodeScalars.map { c -> Character in
            CharacterSet.alphanumerics.contains(c) && c.isASCII || c == "_" || c == "." || c == "-" ? Character(c) : "_"
        }
        return String(safe) + ".json"
    }
}
