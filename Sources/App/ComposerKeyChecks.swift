import AppKit
import SwiftUI

/// Selftest checks for the message box with real key events in an off-screen window (Omar, Nov 12): Enter sends,
/// Shift-Enter adds a line, a message sent while the agent works steers it, ⌥Enter queues, and a paste over 4,000
/// characters becomes a .txt attachment with a chip instead of filling the box.
@MainActor
extension Checks {
    /// A borderless window off screen that can take the keyboard (only this process's; it never activates Forge).
    final class KeyWindow: NSWindow {
        override var canBecomeKey: Bool { true }
    }

    static func textView(in view: NSView) -> NSTextView? {
        if let t = view as? NSTextView { return t }
        for v in view.subviews { if let t = textView(in: v) { return t } }
        return nil
    }

    static func key(_ window: NSWindow, _ chars: String, code: UInt16, flags: NSEvent.ModifierFlags = []) {
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            guard
                let e = NSEvent.keyEvent(
                    with: type, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                    windowNumber: window.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false,
                    keyCode: code)
            else { continue }
            // ⌘ keys go the way AppKit sends a key equivalent to a window (no menu bar in a check).
            if type == .keyDown, flags.contains(.command), window.performKeyEquivalent(with: e) { continue }
            NSApp.sendEvent(e)
        }
        settle()
    }

    static func composerKeyChecks(_ check: (String, Bool) -> Void) {
        let m = SessionsModel(preview: true)
        guard let si = m.sessions.firstIndex(where: { $0.origin != "card" && !$0.chats.isEmpty }) else { return check("a sample chat", false) }
        m.sessions[si].chats[0].state = "working"
        let s = m.sessions[si]
        let chat = s.chats[0]
        m.selected = s.id
        m.drafts[chat.id] = ""
        var sent: [(text: String, queue: Bool, texts: Int)] = []
        m.onSend = { _, text, queue, texts in sent.append((text, queue, texts.count)) }
        let size = NSSize(width: 820, height: 260)
        let host = NSHostingView(rootView: Composer(sessions: m, session: s, chat: chat).frame(width: size.width, height: size.height))
        host.frame = NSRect(origin: .zero, size: size)
        NSApplication.shared.setActivationPolicy(.prohibited)
        let window = KeyWindow(
            contentRect: NSRect(x: -20000, y: -20000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered,
            defer: false)
        window.alphaValue = 0
        window.contentView = host
        window.orderFrontRegardless()
        window.makeKey()
        defer { window.orderOut(nil) }
        settle()
        guard let tv = textView(in: host) else { return check("the message box has a text view", false) }
        window.makeFirstResponder(tv)
        settle()
        key(window, "h", code: 4)
        key(window, "i", code: 34)
        key(window, "\r", code: 36, flags: .shift)
        key(window, "x", code: 7)
        check("Shift-Enter adds a new line and sends nothing", m.drafts[chat.id] == "hi\nx" && sent.isEmpty)
        key(window, "\r", code: 36)
        check("Enter sends the message", sent.count == 1 && sent.first?.text == "hi\nx")
        check("sent while the agent works, it steers the running turn (not queued)", sent.first?.queue == false)
        check("the box is empty again after sending", m.drafts[chat.id]?.isEmpty == true)
        key(window, "q", code: 12)
        key(window, "\r", code: 36, flags: .option)
        check("⌥Enter queues it for after the turn", sent.count == 2 && sent.last?.queue == true)

        // ⌘V the way AppKit sends it, from a private clipboard standing in for the real one (PasteChecks.swift).
        let menu = editMenu()
        let pasted = withPrivateClipboard { board in
            let long = String(repeating: "a line from a long log\n", count: 200)
            put(board, long)
            command(window, "v", code: 9, menu: menu)
            let attached = m.texts[chat.id] ?? []
            check(
                "a paste over 4,000 characters becomes a .txt attachment",
                attached.count == 1 && attached.first?.text == long && attached.first?.name.hasSuffix(".txt") == true)
            check("and doesn't fill the message box", m.drafts[chat.id]?.isEmpty == true)
            check("the chip says what it is", PastedTextChip.words(attached.first ?? PastedText(text: "")) == "Pasted text · 4,600 characters")
            put(board, "short")
            command(window, "v", code: 9, menu: menu)
            check("a short paste goes into the box as usual", m.drafts[chat.id] == "short" && (m.texts[chat.id] ?? []).count == 1)
        }
        if !pasted { check("a private clipboard stands in for the real one", false) }
        key(window, "\r", code: 36)
        check(
            "the attachment goes with the next message and leaves the box",
            sent.count == 3 && (m.texts[chat.id] ?? []).isEmpty && sent.last?.texts == 1)
    }
}
