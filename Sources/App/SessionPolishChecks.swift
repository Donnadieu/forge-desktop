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
        scrollChecks(check)
        tabChecks(check)
        createPRChecks(check)
        newSessionChecks(check)
        sidebarChecks(check)
    }

    /// Item 10: the sessions list is grouped; idle and finished groups start folded and open on a click.
    static func sidebarChecks(_ check: (String, Bool) -> Void) {
        let sessions = SessionsModel(preview: true)
        SampleSessions.fill(sessions)
        var list = SampleSessions.all
        list.append(SampleSessions.session("s7", "Old spike", repo: "acme/app", branch: "x/spike", status: "idle", chats: []))
        let shown = SessionList.sections(list, folded: sessions.foldedGroups, search: "", selected: nil)
        let byTitle = Dictionary(uniqueKeysWithValues: shown.map { ($0.title, $0) })
        check(
            "the groups show in order, each with its count",
            shown.map(\.title) == ["Needs you", "Working", "Ready for review", "Idle", "Merged"] && byTitle["Working"]?.count == 3)
        check("idle and merged sessions start folded", byTitle["Idle"]?.rows.isEmpty == true && byTitle["Merged"]?.rows.isEmpty == true)
        check("the groups that need you stay open", byTitle["Needs you"]?.rows.count == 1 && byTitle["Working"]?.rows.count == 3)
        sessions.toggleGroup("Merged")
        let opened = SessionList.sections(list, folded: sessions.foldedGroups, search: "", selected: nil)
        check("a click opens a folded group", opened.first { $0.title == "Merged" }?.rows.count == 1)
        let open = SessionList.sections(list, folded: ["Idle"], search: "", selected: "s7")
        check("the session on screen shows even in a folded group", open.first { $0.title == "Idle" }?.rows.map(\.id) == ["s7"])
        let found = SessionList.sections(list, folded: ["Idle"], search: "spike", selected: nil)
        check("a search shows matches in folded groups too", found.first { $0.title == "Idle" }?.rows.map(\.id) == ["s7"])
    }

    /// Item 9: a new session gets its own folder and branch off main by default, or a branch the person names or picks.
    static func newSessionChecks(_ check: (String, Bool) -> Void) {
        let repo = SessionRepo(repo: "acme/app", local: "/r/app", base: "main")
        func body(_ b: SessionsModel.BranchChoice) -> [String: Any] {
            SessionsModel.createBody(workspace: "w", repo: repo, message: "Fix login", model: "opus", effort: "high", branch: b)
        }
        let auto = body(.new(""))
        check(
            "by default a session branches off main, named by Forge",
            auto["base"] as? String == "main" && auto["branch"] == nil && auto["existing"] as? Bool == false)
        let named = body(.new(" fix-login "))
        check("a new branch can be named", named["branch"] as? String == "fix-login" && named["existing"] as? Bool == false)
        let open = body(.existing("feature/login"))
        check("an existing branch can be opened", open["branch"] as? String == "feature/login" && open["existing"] as? Bool == true)
    }

    /// Item 8: Create PR asks the agent, the way Conductor's create-PR prompt does; nothing is made behind its back.
    static func createPRChecks(_ check: (String, Bool) -> Void) {
        let p = Sessions.Prompt.createPR(base: "main")
        check("Create PR's message says what it asks for first", p.hasPrefix("Create a PR"))
        check("the agent uses the repo's own PR skill or template first", p.contains("skills related to creating PRs") && p.contains("template"))
        check(
            "it commits what's left, pushes, reviews the whole branch and opens the PR onto the base",
            p.contains("git status") && p.contains("git push -u origin HEAD") && p.contains("git diff origin/main...HEAD")
                && p.contains("gh pr create --base main"))
        check("if a step fails the agent asks instead of working around it", p.contains("ask the user for help"))
    }

    /// Item 7: tabs are Chat, Chat 2, Chat 3; a Changes tab only once there are changes; Rename and Close.
    static func tabChecks(_ check: (String, Bool) -> Void) {
        let sessions = SessionsModel(preview: true)
        SampleSessions.fill(sessions)
        var one = sessions.sessions.first { $0.id == "s3" }!
        check("a session's second tab is Chat 2, not Review", SessionsModel.newChatTitle(in: one) == "Chat 2")
        one.chats.append(SampleSessions.chat("cx", "s3", "Chat 2"))
        one.chats.append(SampleSessions.chat("cy", "s3", "Chat 4"))
        check("the next tab takes the next free number", SessionsModel.newChatTitle(in: one) == "Chat 3")
        check("no Changes tab before there are changes", !sessions.showsChangesTab(sessions.sessions.first { $0.id == "s6" }!))
        check("a Changes tab once there are changes", sessions.showsChangesTab(sessions.sessions.first { $0.id == "s1" }!))
        let s1 = sessions.sessions.first { $0.id == "s1" }!
        sessions.rename(s1.chats[1], to: "  Tests  ")
        check("Rename changes the tab's name", sessions.sessions.first { $0.id == "s1" }?.chats[1].title == "Tests")
        sessions.rename(s1.chats[1], to: "   ")
        check("an empty name keeps the old one", sessions.sessions.first { $0.id == "s1" }?.chats[1].title == "Tests")
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
