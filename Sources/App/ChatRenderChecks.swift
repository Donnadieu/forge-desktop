import AppKit
import SwiftUI

/// Selftest checks for the chat's Markdown and file paths (Omar's ATC-1742 review summary, Nov 11): a GFM table
/// renders as a table, task lists, strikethrough and nested lists render, and a path into the session's worktree
/// is a link that opens the file in Forge's viewer. Each failed on the code before its fix.
@MainActor
extension Checks {
    static func chatRenderChecks(_ check: (String, Bool) -> Void) {
        markdownTableChecks(check)
        gfmPieceChecks(check)
        fileLinkChecks(check)
        linkClickChecks(check)
    }

    /// A real click on a link in a drawn message (an off-screen window) opens the file in the viewer.
    static func linkClickChecks(_ check: (String, Bool) -> Void) {
        let root = SampleReview.worktree()
        let sessions = SessionsModel(preview: true)
        let size = NSSize(width: 900, height: 60)
        let view = MessageText(text: "`\(SampleReview.reviewPath)`").opensFileLinks(sessions, root: root)
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
        // A point on the link's first words, near the top left (window points start at the bottom left).
        let at = NSPoint(x: 40, y: size.height - 9)
        func mouse(_ type: NSEvent.EventType) -> NSEvent? {
            NSEvent.mouseEvent(
                with: type, location: at, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0)
        }
        // The press tracks the mouse until it's let go, so the release waits in the queue first.
        if let down = mouse(.leftMouseDown), let up = mouse(.leftMouseUp) {
            NSApp.postEvent(up, atStart: false)
            window.sendEvent(down)
        }
        settle()
        let want = URL(fileURLWithPath: root).appendingPathComponent(SampleReview.reviewPath).standardizedFileURL
        check("a click on a path in a drawn message opens that file in the viewer", sessions.openFile?.url.standardizedFileURL == want)
    }

    /// The kind of each block: "prose", "table", "item"…, so a check reads like the message.
    static func kinds(_ parts: [MarkdownPart]) -> [String] {
        parts.map { String("\($0)".prefix { $0 != "(" }) }
    }

    static func blockText(_ part: MarkdownPart) -> String {
        part.texts.map { String($0.characters) }.joined(separator: "\n")
    }

    static func markdownTableChecks(_ check: (String, Bool) -> Void) {
        let parts = MarkdownCache.parts(SampleReview.summary)
        check("a message with a GFM table draws it as a table", kinds(parts).contains("table"))
        check("no row of a table shows as raw pipe text", !parts.contains { blockText($0).contains("| Lane |") || blockText($0).contains("|---") })
        let table = parts.lazy.compactMap(\.table).first
        let header = table?.header.map { String($0.characters) }
        let rows = table?.rows.map { $0.map { String($0.characters) } }
        check("the table keeps its header row", header == ["Lane", "Critical", "High", "Medium", "Low"])
        check("the table keeps its rows, bold read as bold", rows?.count == 3 && rows?.last?.first == "Total (deduped)")
        let aligned = MarkdownCache.parts("| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |")
        check("a table's columns keep the alignment its separator row asks for", aligned.first?.table?.align == [.leading, .center, .trailing])
        check("a line with a pipe but no separator row stays prose", kinds(MarkdownCache.parts("a | b\nc | d")) == ["prose"])
    }

    static func gfmPieceChecks(_ check: (String, Bool) -> Void) {
        let tasks = MarkdownCache.parts("- [x] Done\n- [ ] Not yet")
        let markers = tasks.compactMap { p -> String? in
            if case .item(let m, _, _) = p { return m }
            return nil
        }
        check("task list items show a box, ticked or not, not \"[ ]\"", markers == ["☑", "☐"] && !tasks.contains { blockText($0).contains("[") })
        let struck = MarkdownCache.inline("~~Drop the cache~~ keep it")
        check(
            "~~strikethrough~~ is struck through",
            struck.runs.contains { $0.inlinePresentationIntent?.contains(.strikethrough) == true } && !String(struck.characters).contains("~"))
        let nested = MarkdownCache.parts("- one\n  - two\n    - three\n1. first\n   - under it")
        let depths = nested.compactMap { p -> Int? in
            if case .item(_, _, let d) = p { return d }
            return nil
        }
        check("nested lists keep their depth", depths == [0, 1, 2, 0, 1])
    }

    static func fileLinkChecks(_ check: (String, Bool) -> Void) {
        let root = SampleReview.worktree()
        let outside = (NSTemporaryDirectory() as NSString).appendingPathComponent("forge-outside-\(UUID().uuidString).txt")
        try? "secret".write(toFile: outside, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(atPath: outside) }
        func links(_ parts: [MarkdownPart]) -> [URL] {
            parts.flatMap { p in (p.texts + (p.table.map { $0.header + $0.rows.flatMap { $0 } } ?? [])).flatMap { $0.runs.compactMap(\.link) } }
        }
        let found = links(MarkdownCache.parts(SampleReview.summary, folder: root))
        let want = [SampleReview.diffPath, SampleReview.reviewPath].map { URL(fileURLWithPath: root).appendingPathComponent($0).standardizedFileURL }
        check("a path in a message becomes a link to that file in the worktree", Set(found.map(\.standardizedFileURL)) == Set(want))
        let rel = "../" + (outside as NSString).lastPathComponent
        check("a path that doesn't exist isn't a link", FileLinks.resolve("tmp/nope/missing.md", root: root) == nil)
        check("a path outside the worktree isn't a link", FileLinks.resolve(rel, root: root) == nil && FileLinks.resolve(outside, root: root) == nil)
        check("a path with a line number still finds the file", FileLinks.resolve(SampleReview.reviewPath + ":12", root: root) == want[1])
        check("words that only look like paths aren't links", links(MarkdownCache.parts("Use e.g. 0.2.33 or `main`.", folder: root)).isEmpty)
        check("without a worktree nothing is a link", links(MarkdownCache.parts(SampleReview.summary, folder: nil)).isEmpty)
        check("a click opens the file in Forge's viewer", FileLinks.open(want[1], root: root, command: false) == .view(want[1]))
        check("a Cmd-click shows it in Finder", FileLinks.open(want[1], root: root, command: true) == .reveal(want[1]))
        check("a link to a file outside the worktree opens nothing", FileLinks.open(URL(fileURLWithPath: outside), root: root, command: false) == nil)
        check("a Markdown file opens rendered", FileKind.of(path: SampleReview.reviewPath, text: SampleReview.review) == .markdown)
        check("a diff saved as .txt opens as a diff", FileKind.of(path: SampleReview.diffPath, text: SampleReview.diff) == .diff)
        check("any other file opens as code", FileKind.of(path: "app/models/talent.rb", text: "class Talent; end") == .code)
        let output = FileLinks.linked("Saved \(SampleReview.diffPath)\nand /etc/hosts", root: root)
        check("a path in a tool's output is a link too", output.runs.compactMap(\.link).map(\.standardizedFileURL) == [want[0]])
    }
}
