import AppKit
import SwiftUI

/// The app's one model: setup answers, which screen shows, and the board's live state.
@MainActor
final class AppModel: ObservableObject {
    @Published var choices: SetupChoices
    @Published var screen: Int
    /// The live board, pushed by the engine.
    @Published var engine: EngineState?
    @Published var engineProblem: String?

    /// Render mode: views draw sample data and never touch Linear, GitHub or the Keychain.
    let preview: Bool
    var sample = Sample()

    /// What render mode shows instead of the person's real Linear and GitHub.
    struct Sample {
        var teams = [LinearAPI.Team(id: "t1", name: "Engineering", key: "ENG", triageEnabled: false)]
        var projects = [LinearAPI.Project(id: "p1", name: "Forge Desktop test", slugId: "forge-desktop-test")]
        var states = ["Backlog", "Todo", "In Progress", "Done", "Canceled"]
    }

    init(preview: Bool = false, choices: SetupChoices? = nil, screen: Int? = nil) {
        self.preview = preview
        let c = choices ?? (preview ? SetupChoices() : SetupChoices.load())
        self.choices = c
        self.screen = screen ?? c.nextScreen
    }

    static let screenTitles = ["Linear", "Project", "GitHub", "Repo", "Agent", "Board"]

    func save() {
        if !preview { choices.save() }
    }

    func go(_ s: Int) {
        screen = max(0, min(5, s))
    }

    func next() {
        save()
        go(screen + 1)
    }

    var linearKey: String? { preview ? "preview" : Keychain.get(.linearKey) }

    var linear: LinearAPI? { linearKey.map { LinearAPI(key: $0) } }

    func openLink(_ s: String) {
        if let u = URL(string: s) { NSWorkspace.shared.open(u) }
    }
}
