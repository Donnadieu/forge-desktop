import AppKit
import SwiftUI

/// Selftest checks for the session terminal (Omar, Nov 12): the screen model reads what a shell prints, a real
/// shell starts on a PTY in the session's folder with the workspace's variables, several per session, resized for
/// real, refused anywhere else, and closed when the session is archived. Written before the code; each failed first.
@MainActor
extension Checks {
    static func terminalChecks(_ check: (String, Bool) -> Void) {
        terminalScreenChecks(check)
        terminalShellChecks(check)
    }

    static func terminalScreenChecks(_ check: (String, Bool) -> Void) {
        let t = TerminalScreen(cols: 20, rows: 4)
        t.feed(Array("ab\r\ncd".utf8))
        check("a shell's lines land on the terminal's lines", t.line(0) == "ab" && t.line(1) == "cd")
        t.feed(Array("\u{1B}[2J\u{1B}[Hhello\u{1B}[3D\u{1B}[K".utf8))
        check("clearing the screen, moving back and erasing the line work", t.line(0) == "he" && t.line(1).isEmpty)
        t.feed(Array("\r\n\u{1B}[31mred\u{1B}[0m ok".utf8))
        check("colours stick to the letters they were set for", t.cell(row: 1, col: 0).fg == 1 && t.cell(row: 1, col: 4).fg == nil)
        let w = TerminalScreen(cols: 5, rows: 2)
        w.feed(Array("abcdefgh\r\nnext\r\nlast".utf8))
        check("a long line wraps and old lines scroll into the history", w.line(0) == "next" && w.line(1) == "last" && w.history.contains("abcde"))
        let alt = TerminalScreen(cols: 10, rows: 3)
        alt.feed(Array("shell$ ".utf8))
        alt.feed(Array("\u{1B}[?1049h\u{1B}[Hfull screen".utf8))
        let inAlt = alt.line(0)
        alt.feed(Array("\u{1B}[?1049l".utf8))
        check("a full-screen program gets its own screen and gives the shell's back", inAlt == "full scree" && alt.line(0) == "shell$")
        let utf = TerminalScreen(cols: 10, rows: 1)
        utf.feed(Array("café ✓".utf8))
        check("letters beyond ASCII print as themselves", utf.line(0) == "café ✓")
        check(
            "Return, arrows and ⌃C turn into what a shell reads",
            TerminalKeys.bytes(chars: "\r", key: 36, control: false) == [13]
                && TerminalKeys.bytes(chars: "", key: 126, control: false) == Array("\u{1B}[A".utf8)
                && TerminalKeys.bytes(chars: "c", key: 8, control: true) == [3])
    }

    /// A scratch folder standing in for a session's worktree.
    static func scratchWorktree() -> String? {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("forge-terminal-check-\(UUID().uuidString.prefix(6))")
        do { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) } catch { return nil }
        return dir.resolvingSymlinksInPath().path
    }

    static func waitFor(_ seconds: Double, _ done: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if done() { return true }
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        return done()
    }

    static func terminalShellChecks(_ check: (String, Bool) -> Void) {
        guard let folder = scratchWorktree() else { return check("a scratch folder for the terminal", false) }
        defer { try? FileManager.default.removeItem(atPath: folder) }
        let m = SessionsModel(preview: true)
        guard var s = m.sessions.first else { return check("the sample sessions load", false) }
        s.folder = folder
        s.archived = false
        m.sessions[0] = s
        let terms = Terminals()
        terms.shell = "/bin/sh"
        let env = ["FORGE_CHECK_VAR": "from-the-workspace"]
        let first = terms.open(s, env: env)
        check("a terminal opens for a session whose folder is here", first != nil && terms.tabs(of: s.id).count == 1)
        guard let tab = first else { return }
        tab.write(Array("pwd -P; echo \"var=$FORGE_CHECK_VAR\"; echo \"term=$TERM\"\r".utf8))
        let started = waitFor(6) { tab.screen.text.contains("var=from-the-workspace") }
        check("it's a real shell, started in the session's folder", started && tab.screen.text.contains(folder))
        check(
            "with the workspace's variables and a terminal type",
            tab.screen.text.contains("var=from-the-workspace") && tab.screen.text.contains("term=xterm-256color"))
        tab.resize(cols: 100, rows: 30)
        tab.write(Array("stty size\r".utf8))
        check("resizing the panel resizes the shell's terminal", waitFor(4) { tab.screen.text.contains("30 100") })
        let second = terms.open(s, env: env)
        check("a session can have several terminals", second != nil && terms.tabs(of: s.id).map(\.title) == ["Terminal 1", "Terminal 2"])
        var gone = s
        gone.folder = folder + "-missing"
        check(
            "no terminal for a session whose folder isn't on this Mac",
            terms.open(gone, env: env) == nil && terms.problem?.contains("isn't on this Mac") == true)
        var archived = s
        archived.archived = true
        check("no terminal for an archived session", terms.open(archived, env: env) == nil)
        let pids = terms.tabs(of: s.id).map(\.pid)
        let shared = Terminals.shared
        Terminals.shared = terms
        defer { Terminals.shared = shared }
        m.archive(s)
        let closed = waitFor(3) { pids.allSatisfy { kill($0, 0) != 0 } }
        check("archiving the session closes its terminals and their shells", terms.tabs(of: s.id).isEmpty && closed)
    }
}
