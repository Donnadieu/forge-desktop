import AppKit
import SwiftUI

/// Selftest checks for Open in… (docs/design/open-in.md, Direction A, Omar's pick Nov 12): only the installed apps,
/// found by bundle id; always the session's own folder, never the repo's main checkout; the last app used is
/// remembered per workspace; each kind of app gets its own way to open. Written before the code; each failed first.
/// Nothing here launches an app: the registry and the launcher are stand-ins.
@MainActor
extension Checks {
    static func openInChecks(_ check: (String, Bool) -> Void) {
        openInDetectionChecks(check)
        openInFolderChecks(check)
        openInDefaultChecks(check)
        openInLaunchChecks(check)
        openInModelChecks(check)
        openInScreenChecks(check)
    }

    /// A fake Launch Services: only these bundle ids are "installed".
    static func fakeRegistry(_ ids: [String]) -> (String) -> URL? {
        { id in ids.contains(id) ? URL(fileURLWithPath: "/Applications/Fake \(id).app") : nil }
    }

    static let cursorID = "com.todesktop.230313mzl4w4u92"

    static func openInDetectionChecks(_ check: (String, Bool) -> Void) {
        let found = OpenIn.installed(fakeRegistry([cursorID, "dev.zed.Zed", "com.apple.Terminal", "com.apple.finder"]))
        check("Open in lists exactly the installed apps", found.map(\.app.id) == ["cursor", "zed", "terminal", "finder"])
        check("an app that isn't installed is never listed", !found.contains { $0.app.id == "vscode" || $0.app.id == "xcode" })
        let insiders = OpenIn.installed(fakeRegistry(["com.microsoft.VSCodeInsiders"]))
        check("an app found by its second bundle id is listed once", insiders.map(\.app.id) == ["vscode"])
        check("nothing installed lists nothing", OpenIn.installed(fakeRegistry([])).isEmpty)
        let renamed = OpenIn.installed(
            { $0 == "com.exafunction.windsurf" ? URL(fileURLWithPath: "/Applications/Devin.app") : nil }, name: { _ in "Devin" })
        check("an app that renamed itself shows its own name", renamed.first?.name == "Devin")
        let code = OpenIn.installed(fakeRegistry(["com.microsoft.VSCode"]), name: { _ in "Code" })
        check("VS Code keeps its menu name, not its bundle's", code.first?.name == "VS Code")
        let all = OpenIn.catalog.map(\.id)
        let asked = [
            "vscode", "cursor", "windsurf", "zed", "xcode", "sublime", "rubymine", "webstorm", "intellij", "pycharm", "goland", "nova",
            "terminal", "iterm", "warp", "ghostty", "finder", "github-desktop",
        ]
        check("Open in knows every app Omar asked for", asked.allSatisfy(all.contains))
        let kinds = OpenIn.installed(fakeRegistry([cursorID, "com.googlecode.iterm2", "com.github.GitHubClient", "com.apple.finder"]))
        check(
            "editors come first, then terminals, then Finder and GitHub Desktop",
            kinds.map(\.app.kind) == [.editor, .terminal, .other, .other])
    }

    static func openInFolderChecks(_ check: (String, Bool) -> Void) {
        let chat = SampleSessions.session("o1", "Chat", repo: "o/r", branch: "b", status: "idle", chats: [])
        var card = SampleSessions.session("o2", "Card", repo: "o/r", branch: "forge/X-1", status: "working", origin: "card", chats: [])
        card.folder = "/Users/x/Library/Application Support/Forge/workspaces/X-1"
        check("a chat session opens its own folder", OpenIn.folder(of: chat, checkouts: ["/Users/x/Repos/r"]) == chat.folder)
        check("a card's session opens the card's own folder", OpenIn.folder(of: card, checkouts: ["/Users/x/Repos/r"]) == card.folder)
        var main = chat
        main.folder = "/Users/x/Repos/r"
        check("a session pointing at the repo's main checkout opens nothing", OpenIn.folder(of: main, checkouts: ["/Users/x/Repos/r"]) == nil)
        main.folder = "/Users/x/Repos/r/"
        check("the main checkout is refused with a trailing slash too", OpenIn.folder(of: main, checkouts: ["/Users/x/Repos/r"]) == nil)
        var none = chat
        none.folder = ""
        check("a session with no folder opens nothing", OpenIn.folder(of: none, checkouts: []) == nil)
    }

    static func openInDefaultChecks(_ check: (String, Bool) -> Void) {
        let suite = "forge-open-in-check-\(UUID().uuidString.prefix(6))"
        guard let store = UserDefaults(suiteName: suite) else { return check("a scratch defaults store", false) }
        defer { store.removePersistentDomain(forName: suite) }
        let d = OpenIn.Defaults(store: store)
        check("no app is the default before one was used", d.app(for: "andela") == nil)
        d.set("cursor", for: "andela")
        d.set("zed", for: "forge")
        check("the last app used is remembered for its workspace", d.app(for: "andela") == "cursor")
        check("each workspace keeps its own default", d.app(for: "forge") == "zed")
        check("the default survives a new reader of the same store", OpenIn.Defaults(store: store).app(for: "andela") == "cursor")
        let found = OpenIn.installed(fakeRegistry(["dev.zed.Zed", "com.apple.finder"]))
        check("a default that's no longer installed is not offered", OpenIn.pick(d.app(for: "andela"), among: found) == nil)
        check("an installed default is the one-click app", OpenIn.pick(d.app(for: "forge"), among: found)?.app.id == "zed")
    }

    static func openInLaunchChecks(_ check: (String, Bool) -> Void) {
        let folder = "/Users/x/Library/Application Support/Forge/workspaces/X-1"
        let ids = [cursorID, "com.apple.Terminal", "com.mitchellh.ghostty", "com.apple.finder", "com.github.GitHubClient", "com.apple.dt.Xcode"]
        let found = Dictionary(uniqueKeysWithValues: OpenIn.installed(fakeRegistry(ids)).map { ($0.app.id, $0) })
        let folderURL = URL(fileURLWithPath: folder)
        func plan(_ id: String) -> OpenIn.Launch? { found[id].map { OpenIn.launch($0, folder: folder) } }
        check(
            "an editor opens the folder itself",
            found["cursor"].map { plan("cursor") == OpenIn.Launch(app: $0.url, files: [folderURL], arguments: [], newInstance: false) } == true)
        check("Xcode opens the folder", plan("xcode")?.files == [folderURL] && plan("xcode")?.newInstance == false)
        check("Terminal opens a new window at the folder", plan("terminal")?.files == [folderURL])
        check(
            "Ghostty starts a new window with the folder as its working directory",
            found["ghostty"].map {
                plan("ghostty") == OpenIn.Launch(app: $0.url, files: [], arguments: ["--working-directory=\(folder)"], newInstance: true)
            } == true)
        check("Finder shows the folder", plan("finder")?.files == [folderURL] && plan("finder")?.arguments == [])
        check("GitHub Desktop opens the folder as a repo", plan("github-desktop")?.files == [folderURL])
    }

    static func openInModelChecks(_ check: (String, Bool) -> Void) {
        let suite = "forge-open-in-model-\(UUID().uuidString.prefix(6))"
        guard let store = UserDefaults(suiteName: suite) else { return check("a scratch defaults store", false) }
        defer { store.removePersistentDomain(forName: suite) }
        var launched: [OpenIn.Launch] = []
        var fail = false
        let m = OpenInModel(
            registry: fakeRegistry([cursorID, "dev.zed.Zed"]), defaults: OpenIn.Defaults(store: store),
            launcher: { plan in
                if fail { throw OpenInModel.Failure.didNotOpen("the app was moved or deleted") }
                launched.append(plan)
            })
        var s = SampleSessions.session("o3", "ATC-1742", repo: "o/r", branch: "b", status: "working", origin: "card", chats: [])
        s.workspaceId = "andela"
        s.folder = "/Users/x/Library/Application Support/Forge/workspaces/ATC-1742"
        check("the model lists only installed apps", m.apps.map(\.app.id) == ["cursor", "zed"])
        check("with nothing used yet the button has no one-click app", m.defaultApp(in: "andela") == nil)
        if let zed = m.apps.last { m.open(zed, session: s, checkouts: ["/Users/x/Repos/r"]) }
        // The launch, then what follows it (the default, the confirmation), run on the main actor after the launch.
        _ = waitFor(2) { m.opened[s.id] != nil }
        check("opening sends the session's own folder to the app", launched.first?.files == [URL(fileURLWithPath: s.folder)])
        check("the app just used becomes this workspace's one-click app", m.defaultApp(in: "andela")?.app.id == "zed")
        check("another workspace keeps no default from it", m.defaultApp(in: "forge") == nil)
        check("a quiet confirmation says where it opened", m.opened[s.id] == "Opened in Zed")
        var main = s
        main.folder = "/Users/x/Repos/r"
        launched = []
        if let first = m.apps.first { m.open(first, session: main, checkouts: ["/Users/x/Repos/r"]) }
        _ = waitFor(0.5) { !launched.isEmpty }
        check("the main checkout is never sent to an app", launched.isEmpty && m.problem[main.id] != nil)
        fail = true
        if let first = m.apps.first { m.open(first, session: s, checkouts: []) }
        _ = waitFor(2) { m.problem[s.id] != nil }
        check("an app that doesn't open says so in one line", m.problem[s.id] == "Cursor didn't open: the app was moved or deleted.")
        check("a failed app doesn't become the default", m.defaultApp(in: "andela")?.app.id == "zed")
    }

    /// Small words drawn twice their size, so Vision reads them as surely as a person does.
    static func big<V: View>(_ view: V) -> some View {
        view.padding(20).background(Theme.bg).scaleEffect(2.5, anchor: .topLeading)
            .frame(width: 1200, height: 1800, alignment: .topLeading)
    }

    /// The header shows the one-click app's name, "Open in…" before one was used, and the menu lists the apps.
    static func openInScreenChecks(_ check: (String, Bool) -> Void) {
        let suite = "forge-open-in-screen-\(UUID().uuidString.prefix(6))"
        guard let store = UserDefaults(suiteName: suite) else { return check("a scratch defaults store", false) }
        defer { store.removePersistentDomain(forName: suite) }
        let m = OpenInModel(
            registry: fakeRegistry([cursorID, "dev.zed.Zed", "com.apple.Terminal", "com.apple.finder"]),
            defaults: OpenIn.Defaults(store: store), launcher: { _ in })
        var s = SampleSessions.session("o4", "ATC-1742", repo: "o/r", branch: "b", status: "review", chats: [])
        s.workspaceId = "andela"
        let first = readScreen(big(OpenInButton(openIn: m, session: s, checkouts: [])))
        check("before any app was used the button says Open in…", first.contains { $0.replacingOccurrences(of: " ", with: "").contains("Openin") })
        m.defaults.set("cursor", for: "andela")
        let after = readScreen(big(OpenInButton(openIn: m, session: s, checkouts: [])))
        check("the button names the one-click app", after.contains { $0.contains("Cursor") })
        let menu = readScreen(big(OpenInMenu(openIn: m, session: s, checkouts: [], close: {})))
        check(
            "the menu lists the installed apps in groups, then Copy path",
            ["EDITORS", "Cursor", "Zed", "TERMINALS", "Terminal", "Finder", "Copy path"].allSatisfy { w in menu.contains { $0.contains(w) } })
        check("the menu never lists an app that isn't installed", !menu.contains { $0.contains("VS Code") || $0.contains("Xcode") })
    }
}
