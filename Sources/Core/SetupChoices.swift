import Foundation

/// What setup decided, kept in `setup.json` in Forge's folder. Never a secret: keys live in the Keychain.
struct SetupChoices: Codable, Equatable, Sendable {
    // 1. Linear
    var linearUser: String?
    var linearOrg: String?
    // 2. Project and statuses
    var teamID: String?
    var teamName: String?
    var projectID: String?
    var projectName: String?
    var projectSlug: String?
    var columnsReady = false
    // 3. GitHub and who signs
    var githubLogin: String?
    var authorName: String?
    var authorEmail: String?
    var signing: Signing?
    /// GPG key id, or the path of the public half of the key Forge made.
    var signingKey: String?
    // 4. The repo
    var repo: String?
    var defaultBranch: String?
    var repoChecked = false
    // 5. Who does the work
    var worker: Worker?
    var model: String?
    var workerChecked = false
    // 6. Ready for agents (optional so settings saved before this screen existed still load)
    /// The repo was read and its card made, or the person chose "Skip for now".
    var repoReady: Bool?
    /// The Linear card that gets the repo ready, when one was made.
    var repoReadyCard: String?

    enum Signing: String, Codable, CaseIterable, Sendable {
        /// A key Forge makes, kept in the Keychain and registered on the person's GitHub.
        case forgeKey
        /// The person's own GPG key, already on their GitHub.
        case ownGPG
        /// No signature, chosen knowingly.
        case unsigned
    }

    enum Worker: String, Codable, CaseIterable, Sendable {
        case claude, codex, kimi, apiKey
    }

    /// The first screen that still needs an answer (6 = the board).
    var nextScreen: Int {
        if linearUser == nil { return 0 }
        if projectSlug == nil || !columnsReady { return 1 }
        if githubLogin == nil || signing == nil { return 2 }
        if repo == nil || !repoChecked { return 3 }
        if worker == nil || !workerChecked { return 4 }
        if repoReady != true { return 5 }
        return 6
    }

    static var file: URL { Paths.home.appendingPathComponent("setup.json") }

    static func load() -> SetupChoices {
        guard let d = try? Data(contentsOf: file), let c = try? JSONDecoder().decode(SetupChoices.self, from: d) else { return SetupChoices() }
        return c
    }

    func save() {
        try? FileManager.default.createDirectory(at: Paths.home, withIntermediateDirectories: true)
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try? enc.encode(self).write(to: SetupChoices.file, options: .atomic)
    }
}
