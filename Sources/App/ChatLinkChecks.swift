import AppKit
import SwiftUI

/// Selftest checks for links the agent writes as Markdown (Omar's ATC-1744 Code Review chat, Nov 11):
/// `[tmp/git-diffs/….txt](/Users/…/Application%20Support/…/ATC-1744/tmp/git-diffs/….txt)` showed a macOS "The
/// application can't be opened. -50" alert, because a link with no scheme went to the system. Every file link opens
/// in Forge's viewer, a missing one says so inside Forge, and only web links leave for the browser. Each click is a
/// real mouse event on a drawn message in an off-screen window; nothing reaches NSWorkspace (`openInBrowser` is
/// swapped for a recorder).
@MainActor
extension Checks {
    static let atc1744Diff = "tmp/git-diffs/choose-and-scroll-columns-on-the-talent-page-atc-1744-diff.txt"
    static let atc1744Review = "tmp/code-reviews/choose-and-scroll-columns-on-the-talent-page-atc-1744-nuclear-review.md"

    /// A worktree shaped like a card's: a space in its path ("Application Support"), the two files the review names.
    static func cardWorktree() -> String {
        let root = (NSTemporaryDirectory() as NSString).appendingPathComponent("forge-links Application Support/workspaces/ATC-1744")
        for (path, body) in [(atc1744Diff, SampleReview.diff), (atc1744Review, SampleReview.review)] {
            let url = URL(fileURLWithPath: root).appendingPathComponent(path)
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? body.write(to: url, atomically: true, encoding: .utf8)
        }
        return root
    }

    /// The link as the agent wrote it: the path as words, the absolute path percent-encoded as the target.
    static func agentLink(_ path: String, root: String) -> String {
        "[\(path)](\(agentLinkTarget(path, root: root)))"
    }

    static func chatLinkChecks(_ check: (String, Bool) -> Void) {
        let root = cardWorktree()
        let diff = URL(fileURLWithPath: root).appendingPathComponent(atc1744Diff).standardizedFileURL
        let review = URL(fileURLWithPath: root).appendingPathComponent(atc1744Review).standardizedFileURL
        var sent: [URL] = []
        let browser = FileLinks.openInBrowser
        FileLinks.openInBrowser = { sent.append($0) }
        defer { FileLinks.openInBrowser = browser }

        // 1. The ATC-1744 line, clicked: the diff opens in Forge's viewer, nothing goes to the system.
        var s = click(agentLink(atc1744Diff, root: root) + " (diff)", root: root)
        check(
            "a click on the agent's Markdown link to a worktree file opens it in Forge's viewer",
            s.openFile?.url.standardizedFileURL == diff && s.openFile?.missing == false)
        check("that click never hands the link to another app", sent.isEmpty)

        // The same file named relative to the worktree, and as a file:// URL, and inside a table and a list.
        sent = []
        s = SessionsModel(preview: true)
        let action = FileLinks.action(s, root: root)
        for (written, target) in [("relative", atc1744Review), ("./relative", "./" + atc1744Review), ("file://", review.absoluteString)] {
            s.openFile = nil
            if let url = URL(string: target) { _ = action(url) }
            check("a link written \(written) opens the file in the viewer", s.openFile?.url.standardizedFileURL == review)
        }
        let table = MarkdownCache.parts("| File |\n|---|\n| \(agentLink(atc1744Review, root: root)) |\n\n- \(agentLink(atc1744Diff, root: root))")
        let links = table.flatMap { p in (p.texts + (p.table.map { $0.header + $0.rows.flatMap { $0 } } ?? [])).flatMap { $0.runs.compactMap(\.link) }
        }
        var opened: [URL] = []
        for link in links {
            s.openFile = nil
            _ = action(link)
            if let u = s.openFile?.url.standardizedFileURL { opened.append(u) }
        }
        let ok = kinds(table) == ["table", "item"] && Set(opened) == [review, diff] && opened.count == links.count
        if !ok { print("  table/list: \(kinds(table)) links \(links) opened \(opened)") }
        check("links in a table cell and a list item open in the viewer", ok)
        check("no file link went to another app", sent.isEmpty)

        // 2. A link to a file that isn't there: a quiet note inside Forge, never the system.
        sent = []
        s = click("[tmp/code-reviews/gone.md](tmp/code-reviews/gone.md)", root: root)
        check(
            "a click on a link to a missing file says so inside Forge", s.openFile?.missing == true && s.openFile?.url.lastPathComponent == "gone.md")
        check("a missing file's link never goes to another app", sent.isEmpty)
        let outside = (NSTemporaryDirectory() as NSString).appendingPathComponent("forge-links-outside-\(UUID().uuidString).txt")
        try? "secret".write(toFile: outside, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(atPath: outside) }
        s = SessionsModel(preview: true)
        _ = FileLinks.action(s, root: root)(URL(fileURLWithPath: outside))
        _ = FileLinks.action(s, root: root)(URL(string: "../../../" + (outside as NSString).lastPathComponent)!)
        check("a link outside the worktree opens nothing there, only the note", s.openFile?.missing == true && sent.isEmpty)

        check(
            "a file with a line number is a path, an app's own link isn't",
            FileLinks.path(of: URL(string: "README.md:12")!) == "README.md:12" && FileLinks.path(of: URL(string: "mailto:help")!) == nil
                && FileLinks.path(of: URL(string: "x-apple.systempreferences:com.apple.preference")!) == nil)

        // 3. A web link still goes to the browser, and only it.
        sent = []
        s = click("[the pull request](https://github.com/Donnadieu/forge-desktop/pull/1)", root: root)
        check("a click on a web link opens it in the browser", sent == [URL(string: "https://github.com/Donnadieu/forge-desktop/pull/1")!])
        check("a web link opens no viewer", s.openFile == nil)
    }

    /// The target the agent wrote for a path: the absolute path, percent-encoded.
    static func agentLinkTarget(_ path: String, root: String) -> String {
        (root + "/" + path).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? path
    }

    /// Draws `text` as a chat message in an off-screen, see-through window and clicks its first words with a real
    /// mouse press and release. Returns the sessions model the click acted on.
    static func click(_ text: String, root: String) -> SessionsModel {
        let sessions = SessionsModel(preview: true)
        let size = NSSize(width: 900, height: 60)
        let view = MessageText(text: text).opensFileLinks(sessions, root: root)
            .frame(width: size.width, height: size.height, alignment: .topLeading)
        let host = NSHostingView(rootView: view)
        host.frame = NSRect(origin: .zero, size: size)
        NSApplication.shared.setActivationPolicy(.prohibited)
        let window = NSWindow(
            contentRect: NSRect(x: -20000, y: -20000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered,
            defer: false)
        window.alphaValue = 0
        window.contentView = host
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        settle()
        let at = NSPoint(x: 40, y: size.height - 9)
        func mouse(_ type: NSEvent.EventType) -> NSEvent? {
            NSEvent.mouseEvent(
                with: type, location: at, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0)
        }
        if let down = mouse(.leftMouseDown), let up = mouse(.leftMouseUp) {
            NSApp.postEvent(up, atStart: false)
            window.sendEvent(down)
        }
        settle()
        return sessions
    }
}
