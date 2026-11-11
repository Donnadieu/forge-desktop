import AppKit
import SwiftUI

/// Item 6 of the sessions polish: a chat scrolled up stays put when new turns and text arrive; at the bottom it follows.
/// Drives the real transcript list in a window far off screen and reads its scroll position.
@MainActor
extension Checks {
    static func scrollChecks(_ check: (String, Bool) -> Void) {
        let sessions = SessionsModel(preview: true)
        SampleSessions.fill(sessions)
        guard let chat = sessions.sessions.first(where: { $0.id == "s1" })?.chats.first else { return check("the sample chat exists", false) }
        func turn(_ n: Int) -> Sessions.Turn {
            SampleSessions.turn(
                "scroll-\(n)", chat.id, "Message \(n)", status: "done",
                events: [
                    SampleSessions.event("scroll-\(n)-a", "scroll-\(n)", chat.id, "text", String(repeating: "A line of the answer. ", count: 12))
                ])
        }
        let transcript = Transcript(chatID: chat.id, turns: (0..<30).map(turn))
        let size = NSSize(width: 800, height: 500)
        let host = NSHostingView(
            rootView: TranscriptView(sessions: sessions, chat: chat, transcript: transcript).frame(width: size.width, height: size.height))
        host.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(
            contentRect: NSRect(x: -20000, y: -20000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered,
            defer: false)
        window.contentView = host
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        // GitHub's Mac runners are about 4x slower than a desk Mac.
        let wait = ProcessInfo.processInfo.environment["CI"] == nil ? 0.6 : 1.8
        func settle() { RunLoop.main.run(until: Date().addingTimeInterval(wait)) }
        settle()
        guard let scroll = Self.scrollView(in: host) else { return check("the transcript scrolls", false) }
        func top() -> CGFloat { scroll.contentView.bounds.origin.y }
        func atBottom() -> Bool {
            let doc = scroll.documentView?.frame.height ?? 0
            return top() + scroll.contentView.bounds.height >= doc - 4
        }
        check("a chat opens at its latest turn", atBottom())

        scroll.contentView.scroll(to: NSPoint(x: 0, y: 200))
        scroll.reflectScrolledClipView(scroll.contentView)
        settle()
        let before = top()
        transcript.apply(turn(30))
        settle()
        transcript.apply(SampleSessions.event("scroll-30-b", "scroll-30", chat.id, "text", "More text as the agent writes."))
        settle()
        check("scrolled up, new turns and text don't pull the chat down", abs(top() - before) < 2 && !atBottom())

        // Rows are measured as they come on screen, so the list's height settles over a few scrolls.
        for _ in 0..<4 where !atBottom() {
            if let doc = scroll.documentView?.frame.height {
                scroll.contentView.scroll(to: NSPoint(x: 0, y: doc - scroll.contentView.bounds.height))
                scroll.reflectScrolledClipView(scroll.contentView)
            }
            settle()
        }
        transcript.apply(turn(31))
        settle()
        check("at the bottom, a new turn is followed", atBottom())
    }

    private static func scrollView(in view: NSView) -> NSScrollView? {
        if let s = view as? NSScrollView, s.documentView != nil { return s }
        for sub in view.subviews {
            if let s = scrollView(in: sub) { return s }
        }
        return nil
    }
}
