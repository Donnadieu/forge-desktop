import SwiftUI

/// One shell in a session's terminal panel: its screen and its process.
@MainActor
final class TerminalTab: ObservableObject, Identifiable {
    let id = UUID()
    let title: String
    let screen: TerminalScreen
    /// Nil for a screen render's sample tab.
    private let process: TerminalProcess?
    /// Bumped on every output, so the view redraws.
    @Published private(set) var tick = 0
    @Published private(set) var exited = false

    var pid: Int32 { process?.pid ?? 0 }

    init(title: String, process: TerminalProcess, cols: Int, rows: Int) {
        self.title = title
        self.process = process
        screen = TerminalScreen(cols: cols, rows: rows)
        screen.reply = { [weak process] in process?.write($0) }
        process.onOutput = { [weak self] bytes in
            self?.screen.feed(bytes)
            self?.tick &+= 1
        }
        process.onExit = { [weak self] in self?.exited = true }
    }

    /// A tab showing what a sample shell printed (screen renders).
    init(sample title: String, output: String, cols: Int, rows: Int) {
        self.title = title
        process = nil
        screen = TerminalScreen(cols: cols, rows: rows)
        screen.feed(Array(output.utf8))
    }

    func write(_ bytes: [UInt8]) { process?.write(bytes) }

    func resize(cols: Int, rows: Int) {
        guard cols != screen.cols || rows != screen.rows else { return }
        screen.resize(cols: cols, rows: rows)
        process?.resize(cols: cols, rows: rows)
        tick &+= 1
    }

    func close() { process?.terminate() }
}

/// Every session's terminals (Omar, Nov 12): real shells on a PTY, each started in its session's own folder with
/// the workspace's variables, as many per session as wanted, shown in a bottom panel that opens, closes and resizes.
/// Never anywhere else: a session whose folder isn't on this Mac, or that's archived, gets none. Archiving a session
/// closes its shells (`SessionsModel.archive`, SessionsModel+PR.swift).
@MainActor
final class Terminals: ObservableObject {
    static var shared = Terminals()

    @Published private(set) var all: [String: [TerminalTab]] = [:]
    /// Sessions whose panel is open, and the tab each shows.
    @Published var shown: Set<String> = []
    @Published var active: [String: UUID] = [:]
    /// The panel's height, shared by every session.
    @Published var height: CGFloat = 260
    @Published var problem: String?
    /// The shell to start (nil = the person's login shell). Checks use /bin/sh.
    var shell: String?
    private var opened: [String: Int] = [:]

    func tabs(of session: String) -> [TerminalTab] { all[session] ?? [] }

    func current(of session: String) -> TerminalTab? {
        let list = tabs(of: session)
        return list.first { $0.id == active[session] } ?? list.last
    }

    /// A new shell in the session's folder. Nil (and `problem` says why) when that folder can't be used.
    @discardableResult
    func open(_ s: Sessions.Session, env: [String: String], cols: Int = 100, rows: Int = 16) -> TerminalTab? {
        problem = nil
        guard !s.archived else {
            problem = "This session is archived. Restore it to open a terminal."
            return nil
        }
        var isDir: ObjCBool = false
        guard !s.folder.isEmpty, FileManager.default.fileExists(atPath: s.folder, isDirectory: &isDir), isDir.boolValue else {
            problem = "This session's folder isn't on this Mac, so there's nowhere to open a terminal."
            return nil
        }
        let sh = shell ?? TerminalProcess.loginShell
        let environment = TerminalProcess.environment(folder: s.folder, extra: env)
        guard let p = TerminalProcess.start(shell: sh, folder: s.folder, env: environment, cols: cols, rows: rows) else {
            problem = "Forge couldn't start a shell in this session's folder."
            return nil
        }
        let n = (opened[s.id] ?? 0) + 1
        opened[s.id] = n
        let tab = TerminalTab(title: "Terminal \(n)", process: p, cols: cols, rows: rows)
        all[s.id, default: []].append(tab)
        active[s.id] = tab.id
        shown.insert(s.id)
        return tab
    }

    /// Puts sample tabs on a session (screen renders).
    func sample(_ tabs: [TerminalTab], on session: String) {
        all[session] = tabs
        active[session] = tabs.first?.id
        opened[session] = tabs.count
        shown.insert(session)
    }

    func close(_ tab: TerminalTab, in session: String) {
        tab.close()
        all[session]?.removeAll { $0.id == tab.id }
        if tabs(of: session).isEmpty {
            all[session] = nil
            shown.remove(session)
            opened[session] = nil
        } else if active[session] == tab.id {
            active[session] = tabs(of: session).last?.id
        }
    }

    /// The session went away (archived): its shells and everything they started go too.
    func closeAll(_ session: String) {
        for t in tabs(of: session) { t.close() }
        all[session] = nil
        shown.remove(session)
        active[session] = nil
        opened[session] = nil
    }

    /// The Terminal button: opens the panel (with a first shell) or hides it; hidden shells keep running.
    func toggle(_ s: Sessions.Session, env: [String: String]) {
        if shown.contains(s.id) {
            shown.remove(s.id)
        } else if tabs(of: s.id).isEmpty {
            open(s, env: env)
        } else {
            shown.insert(s.id)
        }
    }
}
