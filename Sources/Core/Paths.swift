import Foundation

/// Where Forge keeps its things on this Mac. `FORGE_HOME` moves everything (checks use a scratch folder).
enum Paths {
    static var home: URL {
        if let h = ProcessInfo.processInfo.environment["FORGE_HOME"], !h.isEmpty { return URL(fileURLWithPath: h) }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Forge")
    }

    /// The workflow: the pipeline's settings and the lead agent's instructions. Written by setup.
    static var workflow: URL { home.appendingPathComponent("WORKFLOW.md") }

    /// One folder per card.
    static var cards: URL { home.appendingPathComponent("workspaces") }

    static var logs: URL {
        if ProcessInfo.processInfo.environment["FORGE_HOME"] != nil { return home.appendingPathComponent("logs") }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Forge")
    }
}
