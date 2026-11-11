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
