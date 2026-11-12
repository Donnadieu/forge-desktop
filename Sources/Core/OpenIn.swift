import Foundation

/// Open in…: a session's own folder (its worktree, never the repo's main checkout) in an app on the Mac
/// (docs/design/open-in.md, Direction A). Apps are found by bundle id, only installed ones are offered, and the last one
/// used is remembered per workspace as the one-click app. Pure: Launch Services and the launch itself are passed in.
enum OpenIn {
    enum Kind: Equatable, Sendable { case editor, terminal, other }

    /// How an app takes the folder: opened with it (editors, most terminals, Finder, GitHub Desktop), or started as a
    /// new instance with the folder as an argument (Ghostty, which ignores an opened folder).
    enum How: Equatable, Sendable {
        case openFolder
        case newInstance(flag: String)
    }

    struct App: Equatable, Sendable, Identifiable {
        var id: String
        var name: String
        /// The app's bundle ids, the usual one first; the first one installed wins.
        var bundleIDs: [String]
        var kind: Kind
        var how: How = .openFolder
        /// Show the installed app's own name (Windsurf's bundle id now ships as Devin).
        var ownName = false
    }

    /// An app that's installed: where Launch Services found it.
    struct Found: Equatable, Identifiable {
        var app: App
        var url: URL
        var name: String
        var id: String { app.id }
    }

    /// What to hand Launch Services: the app, the files to open with it, its arguments, and whether to start a new copy.
    struct Launch: Equatable {
        var app: URL
        var files: [URL]
        var arguments: [String]
        var newInstance: Bool
    }

    /// Every app Open in knows, in the menu's order: editors, terminals, then Finder and GitHub Desktop.
    static let catalog: [App] = [
        App(id: "cursor", name: "Cursor", bundleIDs: ["com.todesktop.230313mzl4w4u92"], kind: .editor),
        App(id: "vscode", name: "VS Code", bundleIDs: ["com.microsoft.VSCode", "com.microsoft.VSCodeInsiders"], kind: .editor),
        App(id: "windsurf", name: "Windsurf", bundleIDs: ["com.exafunction.windsurf"], kind: .editor, ownName: true),
        App(id: "zed", name: "Zed", bundleIDs: ["dev.zed.Zed", "dev.zed.Zed-Preview"], kind: .editor),
        App(id: "xcode", name: "Xcode", bundleIDs: ["com.apple.dt.Xcode"], kind: .editor),
        App(id: "sublime", name: "Sublime Text", bundleIDs: ["com.sublimetext.4", "com.sublimetext.3"], kind: .editor),
        App(id: "nova", name: "Nova", bundleIDs: ["com.panic.Nova"], kind: .editor),
        App(id: "rubymine", name: "RubyMine", bundleIDs: ["com.jetbrains.rubymine"], kind: .editor),
        App(id: "webstorm", name: "WebStorm", bundleIDs: ["com.jetbrains.WebStorm"], kind: .editor),
        App(id: "intellij", name: "IntelliJ IDEA", bundleIDs: ["com.jetbrains.intellij", "com.jetbrains.intellij.ce"], kind: .editor),
        App(id: "pycharm", name: "PyCharm", bundleIDs: ["com.jetbrains.pycharm", "com.jetbrains.pycharm.ce"], kind: .editor),
        App(id: "goland", name: "GoLand", bundleIDs: ["com.jetbrains.goland"], kind: .editor),
        App(id: "terminal", name: "Terminal", bundleIDs: ["com.apple.Terminal"], kind: .terminal),
        App(id: "iterm", name: "iTerm2", bundleIDs: ["com.googlecode.iterm2"], kind: .terminal),
        App(id: "warp", name: "Warp", bundleIDs: ["dev.warp.Warp-Stable"], kind: .terminal),
        App(
            id: "ghostty", name: "Ghostty", bundleIDs: ["com.mitchellh.ghostty"], kind: .terminal,
            how: .newInstance(flag: "--working-directory=")),
        App(id: "finder", name: "Finder", bundleIDs: ["com.apple.finder"], kind: .other),
        App(id: "github-desktop", name: "GitHub Desktop", bundleIDs: ["com.github.GitHubClient"], kind: .other),
    ]

    /// The installed apps, in the catalog's order. `registry` answers a bundle id with the app's location, or nil
    /// (in the app: `NSWorkspace.urlForApplication(withBundleIdentifier:)`); `name` reads an app's own name.
    static func installed(_ registry: (String) -> URL?, name: (URL) -> String? = bundleName) -> [Found] {
        catalog.compactMap { app in
            app.bundleIDs.lazy.compactMap(registry).first.map { url in
                Found(app: app, url: url, name: app.ownName ? (name(url) ?? app.name) : app.name)
            }
        }
    }

    /// The name an app shows for itself, from its Info.plist.
    static func bundleName(_ url: URL) -> String? {
        let info = Bundle(url: url)?.infoDictionary
        return (info?["CFBundleDisplayName"] ?? info?["CFBundleName"]) as? String
    }

    /// The folder to open for a session: its own folder, or nil when it has none or it is one of the workspace's main
    /// checkouts (sessions work in worktrees; the main checkout holds other work).
    static func folder(of session: Sessions.Session, checkouts: [String]) -> String? {
        let own = clean(session.folder)
        guard !own.isEmpty, !checkouts.map(clean).contains(own) else { return nil }
        return session.folder
    }

    private static func clean(_ path: String) -> String {
        path.isEmpty ? "" : URL(fileURLWithPath: path).standardizedFileURL.path
    }

    /// How to open `folder` in an installed app.
    static func launch(_ found: Found, folder: String) -> Launch {
        switch found.app.how {
        case .openFolder:
            return Launch(app: found.url, files: [URL(fileURLWithPath: folder)], arguments: [], newInstance: false)
        case .newInstance(let flag):
            return Launch(app: found.url, files: [], arguments: [flag + folder], newInstance: true)
        }
    }

    /// The one-click app: the remembered one, if it's still installed.
    static func pick(_ id: String?, among found: [Found]) -> Found? {
        id.flatMap { id in found.first { $0.id == id } }
    }

    /// The last app used, per workspace.
    struct Defaults {
        let store: UserDefaults

        private func key(_ workspace: String) -> String { "openIn.default.\(workspace)" }
        func app(for workspace: String) -> String? { store.string(forKey: key(workspace)) }
        func set(_ id: String, for workspace: String) { store.set(id, forKey: key(workspace)) }
    }
}
