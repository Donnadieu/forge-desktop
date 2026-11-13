import AppKit
import SwiftUI

/// Open in… on the Sessions screen (docs/design/open-in.md, Direction A): the installed apps, the one-click app per
/// workspace, and what happened after a click. Launch Services and the launch are passed in, so checks never open an app.
@MainActor
final class OpenInModel: ObservableObject {
    /// The app's own: the real registry, the person's defaults, the real launch.
    static var shared = OpenInModel(
        registry: { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) }, defaults: OpenIn.Defaults(store: .standard),
        launcher: OpenInModel.launch)

    enum Failure: Error { case didNotOpen(String) }

    let defaults: OpenIn.Defaults
    private let registry: (String) -> URL?
    private let launcher: (OpenIn.Launch) async throws -> Void
    @Published private(set) var apps: [OpenIn.Found] = []
    /// "Opened in Cursor" for two seconds, per session.
    @Published var opened: [String: String] = [:]
    /// The one line when an app didn't open, per session.
    @Published var problem: [String: String] = [:]
    /// The session whose menu is open (⌘O with no app picked yet opens it too).
    @Published var menuFor: String?
    /// Where Copy path writes; checks never touch the person's clipboard.
    var pasteboard: NSPasteboard? = .general
    private var icons: [String: NSImage] = [:]

    init(registry: @escaping (String) -> URL?, defaults: OpenIn.Defaults, launcher: @escaping (OpenIn.Launch) async throws -> Void) {
        self.registry = registry
        self.defaults = defaults
        self.launcher = launcher
        refresh()
    }

    /// Looks for the apps again (an app installed while Forge runs shows up the next time the menu opens).
    func refresh() {
        let found = OpenIn.installed(registry)
        if found != apps { apps = found }
    }

    func defaultApp(in workspace: String) -> OpenIn.Found? { OpenIn.pick(defaults.app(for: workspace), among: apps) }

    func open(_ found: OpenIn.Found, session: Sessions.Session, checkouts: [String]) {
        problem[session.id] = nil
        guard let folder = OpenIn.folder(of: session, checkouts: checkouts) else {
            problem[session.id] = "This session has no folder of its own to open."
            return
        }
        let plan = OpenIn.launch(found, folder: folder)
        Task {
            do {
                try await launcher(plan)
            } catch {
                problem[session.id] = "\(found.name) didn't open: \(Self.reason(error))."
                return
            }
            defaults.set(found.id, for: session.workspaceId)
            let words = "Opened in \(found.name)"
            opened[session.id] = words
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if opened[session.id] == words { opened[session.id] = nil }
        }
    }

    /// ⌘O: the one-click app, or the menu when none was picked yet in this workspace.
    func openDefault(_ session: Sessions.Session, checkouts: [String]) {
        if let app = defaultApp(in: session.workspaceId) {
            open(app, session: session, checkouts: checkouts)
        } else {
            refresh()
            menuFor = session.id
        }
    }

    func copyPath(_ session: Sessions.Session) {
        pasteboard?.clearContents()
        pasteboard?.setString(session.folder, forType: .string)
    }

    func icon(_ found: OpenIn.Found) -> NSImage {
        if let cached = icons[found.id] { return cached }
        let image = NSWorkspace.shared.icon(forFile: found.url.path)
        icons[found.id] = image
        return image
    }

    static func reason(_ error: Error) -> String {
        if case .didNotOpen(let why) = error as? Failure { return why }
        let words = error.localizedDescription
        return words.hasSuffix(".") ? String(words.dropLast()) : words
    }

    /// The real launch: Launch Services opens the folder with the app, or starts a new copy with its arguments.
    nonisolated static func launch(_ plan: OpenIn.Launch) async throws {
        guard FileManager.default.fileExists(atPath: plan.app.path) else { throw Failure.didNotOpen("the app was moved or deleted") }
        let config = NSWorkspace.OpenConfiguration()
        config.arguments = plan.arguments
        config.createsNewApplicationInstance = plan.newInstance
        config.activates = true
        if plan.files.isEmpty {
            _ = try await NSWorkspace.shared.openApplication(at: plan.app, configuration: config)
        } else {
            _ = try await NSWorkspace.shared.open(plan.files, withApplicationAt: plan.app, configuration: config)
        }
    }
}

/// The header's split button: the one-click app (its real icon and name) and a chevron for the others. Before an app
/// was used in this workspace it says "Open in…" and opens the menu. Compact (two chats side by side): icon + chevron.
struct OpenInButton: View {
    @ObservedObject var openIn: OpenInModel
    let session: Sessions.Session
    let checkouts: [String]
    var compact = false
    /// The second chat of a side by side: it keeps a menu of its own, so ⌘O opens only the main one's.
    var side = false

    private var menuKey: String { side ? "\(session.id):side" : session.id }

    var body: some View {
        let app = openIn.defaultApp(in: session.workspaceId)
        HStack(spacing: 0) {
            Button {
                if let app { openIn.open(app, session: session, checkouts: checkouts) } else { show() }
            } label: {
                HStack(spacing: 6) {
                    if let app {
                        Image(nsImage: openIn.icon(app)).resizable().interpolation(.high).frame(width: 16, height: 16)
                    } else {
                        Image(systemName: "folder").font(Theme.icon(.glyph, .medium))
                    }
                    if !compact || app == nil { Text(openIn.opened[session.id] ?? app?.name ?? "Open in…") }
                }
            }
            .buttonStyle(ForgeButton(kind: .ghost))
            .help(app.map { "Open \(session.title) in \($0.name) ⌘O" } ?? "Pick an app to open this session's folder")
            Rectangle().fill(Theme.border).frame(width: 1, height: 14)
            Button(action: show) {
                Image(systemName: "chevron.down").font(Theme.icon(.glyphXS, .semibold))
            }
            .buttonStyle(ForgeButton(kind: .ghost))
            .help("Open in…")
        }
        .frame(height: 28)
        .fixedSize()
        .popover(
            isPresented: Binding(get: { openIn.menuFor == menuKey }, set: { if !$0 { openIn.menuFor = nil } }),
            arrowEdge: .bottom
        ) {
            OpenInMenu(openIn: openIn, session: session, checkouts: checkouts) { openIn.menuFor = nil }
        }
    }

    private func show() {
        openIn.refresh()
        openIn.menuFor = menuKey
    }
}

/// The list the chevron opens (also drawn on its own for screen renders): the installed apps in groups, each with its
/// real icon, a check and ⌘O on the one-click app, then Copy path with the folder.
struct OpenInMenu: View {
    @ObservedObject var openIn: OpenInModel
    let session: Sessions.Session
    let checkouts: [String]
    let close: () -> Void

    private var groups: [(label: String?, apps: [OpenIn.Found])] {
        [("Editors", OpenIn.Kind.editor), ("Terminals", .terminal), (nil, .other)].compactMap { label, kind in
            let apps = openIn.apps.filter { $0.app.kind == kind }
            return apps.isEmpty ? nil : (label, apps)
        }
    }

    var body: some View {
        let chosen = openIn.defaultApp(in: session.workspaceId)?.id
        VStack(alignment: .leading, spacing: 0) {
            if openIn.apps.isEmpty {
                Text("Forge found no app on this Mac to open this folder.").font(Theme.sans(.small)).foregroundStyle(Theme.textSec)
                    .padding(.horizontal, 14).padding(.vertical, 8)
            }
            ForEach(Array(groups.enumerated()), id: \.offset) { i, group in
                if let label = group.label {
                    SectionLabel(text: label).padding(.horizontal, 14).padding(.top, i == 0 ? 6 : 10).padding(.bottom, 4)
                } else if i > 0 {
                    line.padding(.vertical, 6)
                }
                ForEach(group.apps) { app in
                    OpenInRow(icon: openIn.icon(app), name: app.name, chosen: app.id == chosen) {
                        close()
                        openIn.open(app, session: session, checkouts: checkouts)
                    }
                }
            }
            line.padding(.vertical, 6)
            Button {
                openIn.copyPath(session)
                close()
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Copy path").font(Theme.sans(.body)).foregroundStyle(Theme.text)
                    Text(Self.short(session.folder)).font(Theme.mono(.label)).foregroundStyle(Theme.textMuted)
                        .lineLimit(1).truncationMode(.middle)
                }
                .padding(.leading, 36).padding(.trailing, 14).padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 8)
        .frame(width: 260)
        .background(Theme.surface)
    }

    private var line: some View { Rectangle().fill(Theme.border).frame(height: 1) }

    /// The folder with the home folder as ~.
    static func short(_ path: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
    }
}

/// One app in the menu: a check when it's the one-click app, its real icon, its name, and ⌘O on the chosen one.
struct OpenInRow: View {
    let icon: NSImage
    let name: String
    let chosen: Bool
    let pick: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: pick) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark").font(Theme.icon(.glyphXS, .bold)).foregroundStyle(Theme.text).frame(width: 12)
                    .opacity(chosen ? 1 : 0)
                Image(nsImage: icon).resizable().interpolation(.high).frame(width: 16, height: 16)
                Text(name).font(Theme.sans(.body)).foregroundStyle(Theme.text).lineLimit(1)
                Spacer(minLength: 8)
                if chosen { KeyHint(text: "⌘O") }
            }
            .padding(.horizontal, 10).frame(height: 28)
            .background(RoundedRectangle(cornerRadius: Theme.rSm).fill(hover ? Theme.surfaceHover : .clear))
            .padding(.horizontal, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}
