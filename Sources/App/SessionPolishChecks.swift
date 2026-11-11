import AppKit
import SwiftUI

/// Selftest checks for the sessions polish (docs/exec-plans/active/sessions-polish.md): each one failed on the code
/// before its fix.
@MainActor
extension Checks {
    static func sessionPolishChecks(_ check: (String, Bool) -> Void) {
        let sessions = SessionsModel(preview: true)
        SampleSessions.fill(sessions)
        var long = sessions.sessions.first { $0.id == "s4" }!
        long.branch = "donnadieu86/per-32-get-donnadieuintake-workspace-ready-for-agents"
        let panel = NSHostingController(rootView: ChangesPanel(sessions: sessions, session: long))
        let fit = panel.sizeThatFits(in: CGSize(width: ChangesPanel.width, height: 700))
        check("the Changes panel stays inside its own width with a long branch name", fit.width <= ChangesPanel.width + 0.5)
        // The narrowest window (1100) leaves the chat 1100 - 260 (list) - 360 (Changes) - 2 (edges) points.
        let model = AppModel(preview: true)
        let chat = NSHostingController(rootView: ChatColumn(model: model, sessions: sessions, session: long))
        let room: CGFloat = 1100 - 260 - ChangesPanel.width - 2
        check(
            "a card's chat and its message box fit beside the Changes panel in the narrowest window",
            chat.sizeThatFits(in: CGSize(width: room, height: 700)).width <= room + 0.5)

        promptChecks(check)
        toolRowChecks(check)
        syntaxChecks(check)
    }

    /// Item 5: code is coloured by its language, in chat code blocks and in the diff.
    static func syntaxChecks(_ check: (String, Bool) -> Void) {
        let swift = Syntax.tokens("let name = \"Forge\" // the app", language: "swift")
        check(
            "Swift: a keyword, a string and a comment are told apart",
            swift.contains(.init(.keyword, "let")) && swift.contains(.init(.string, "\"Forge\"")) && swift.contains(.init(.comment, "// the app")))
        let py = Syntax.tokens("def total(n): return n + 42  # sum", language: Syntax.language(path: "orders/total.py"))
        check(
            "Python, picked from the file's name: keyword, number and # comment",
            py.contains(.init(.keyword, "def")) && py.contains(.init(.number, "42")) && py.contains(.init(.comment, "# sum")))
        let sh = Syntax.tokens("bin/rubocop --parallel # lint", language: "sh")
        let block = Syntax.tokens("// first\nlet a = 1", language: "swift")
        check(
            "a comment ends at its line; the next line is coloured too",
            block.contains(.init(.comment, "// first")) && block.contains(.init(.keyword, "let")))
        check("a shell line's comment is coloured", sh.contains(.init(.comment, "# lint")))
        check("an unknown language is left plain", Syntax.tokens("let x = 1", language: nil) == [.init(.plain, "let x = 1")])
        let tokens = Syntax.tokens("func a() {}", language: "swift")
        check("colouring never drops or adds a character", tokens.map(\.text).joined() == "func a() {}")
        let row = DiffLines.styled("+let a = 1", language: "swift")
        check(
            "a diff line is coloured after its + or −",
            row.runs.contains { String(row[$0.range].characters) == "let" && $0.foregroundColor == Theme.codeKeyword })
        let fence = MarkdownCache.parts("```swift\nlet a = 1\n```")
        if case .code(_, let lang)? = fence.first {
            check("a code block keeps the language its fence names", lang == "swift")
        } else {
            check("a code block keeps the language its fence names", false)
        }
    }

    /// Item 4: what ran is easy to see: a mark per kind of tool, the command apart from its output, an edit as lines.
    static func toolRowChecks(_ check: (String, Bool) -> Void) {
        func tool(_ name: String, _ input: [String: JSONValue]) -> Sessions.Event {
            SampleSessions.event("x", "t", "c", "tool", "", name: name, data: .object(input))
        }
        func result(_ text: String, error: Bool = false) -> Sessions.Event {
            var e = SampleSessions.event("r", "t", "c", "tool_result", text)
            e.ref = "x"
            e.isError = error
            return e
        }
        check(
            "each kind of tool has its own mark",
            ToolStyle.of("Bash").icon == "terminal" && ToolStyle.of("Read").icon == "doc.text" && ToolStyle.of("Edit").icon == "pencil"
                && ToolStyle.of("Grep").icon == "magnifyingglass" && ToolStyle.of("mcp__x__y").icon == "wrench")
        let ran = ToolDetail.parts(tool("Bash", ["command": .string("make lint")]), result("ok\nall clean"))
        check("a command shows apart from what it printed", ran == [.command("make lint"), .output("ok\nall clean", failed: false)])
        let failed = ToolDetail.parts(tool("Bash", ["command": .string("make test")]), result("1 failed", error: true))
        check("a command that failed says so on its output", failed.last == .output("1 failed", failed: true))
        let edit = ToolDetail.parts(tool("Edit", ["old_string": .string("a\nb"), "new_string": .string("c")]), nil)
        check("an edit shows the lines it took out and put in", edit == [.change(removed: ["a", "b"], added: ["c"])])
        let read = ToolDetail.parts(tool("Read", ["file_path": .string("/r/x.swift")]), result("1\tlet a = 1"))
        check("a file read shows what it read", read == [.output("1\tlet a = 1", failed: false)])
    }

    /// Item 2: the card's prompt reads as formatted text, folded to a short preview.
    static func promptChecks(_ check: (String, Bool) -> Void) {
        let shown = MarkdownCache.parts(SampleSessions.cardPrompt).map(Self.plain).joined(separator: "\n")
        check(
            "a prompt's Markdown is drawn, not shown as marks (no #, list stars or **)",
            !shown.contains("## ") && !shown.contains("### ") && !shown.contains("* ") && !shown.contains("**") && !shown.contains("- This"))
        check(
            "a prompt's list items and code survive the drawing",
            shown.contains("Resume from the current workspace state") && shown.contains("bin/rubocop"))
        let code = MarkdownCache.inline("Run `make lint` first")
        check("inline code is drawn in mono", code.runs.contains { $0.font != nil && String(code[$0.range].characters) == "make lint" })
        let bubble = NSHostingController(rootView: UserBubble(text: SampleSessions.cardPrompt) { EmptyView() })
        let tall = bubble.sizeThatFits(in: CGSize(width: 760, height: 10_000)).height
        check("a long prompt opens folded to a short preview", tall < 260)
    }

    private static func plain(_ p: MarkdownPart) -> String {
        switch p {
        case .prose(let a), .heading(_, let a), .item(_, let a, _): return String(a.characters)
        case .code(let c, _): return c
        }
    }
}
