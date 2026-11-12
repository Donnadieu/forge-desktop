import AppKit
import SwiftUI

/// Selftest checks for copying out of the session Terminal and the chat (Omar, Nov 12): a real drag highlights and
/// ⌘C, right-click Copy and Edit > Copy copy it; double- and triple-click pick a word and a line; ⌥-drag picks a
/// block; ⌘C never reaches the shell while ⌃C still interrupts it. In the chat a drag runs across paragraphs, lists,
/// code and tables, and each message and code block has its own copy button. Off screen, on a private clipboard.
@MainActor
extension Checks {
    static func copyChecks(_ check: (String, Bool) -> Void) {
        let ran = withPrivateClipboard { board in
            terminalSelectionChecks(board, check)
            terminalInterruptChecks(board, check)
            chatSelectionChecks(board, check)
            chatCopyButtonChecks(board, check)
        }
        if !ran { check("a private clipboard stands in for the real one", false) }
    }

    /// A real drag (or click) the way the system delivers it: the moves and the release wait in the queue, then the
    /// press, so a view that tracks the mouse from its press (text, buttons) and one that takes each event both work.
    static func mouseDrag(_ window: NSWindow, from a: NSPoint, to b: NSPoint, steps: Int = 8, clicks: Int = 1, flags: NSEvent.ModifierFlags = []) {
        // Releases other checks left in the queue mustn't end this drag.
        NSApp.discardEvents(matching: [.leftMouseDragged, .leftMouseUp, .rightMouseUp], before: nil)
        let t0 = ProcessInfo.processInfo.systemUptime
        var n = 7000
        func event(_ type: NSEvent.EventType, _ p: NSPoint) -> NSEvent? {
            n += 1
            return NSEvent.mouseEvent(
                with: type, location: p, modifierFlags: flags, timestamp: t0 + Double(n - 7000) * 0.016, windowNumber: window.windowNumber,
                context: nil, eventNumber: n, clickCount: clicks, pressure: type == .leftMouseUp ? 0 : 1)
        }
        guard let down = event(.leftMouseDown, a) else { return }
        for i in 0..<steps where a != b {
            let f = CGFloat(i + 1) / CGFloat(steps)
            if let e = event(.leftMouseDragged, NSPoint(x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f)) { NSApp.postEvent(e, atStart: false) }
        }
        if let up = event(.leftMouseUp, b) { NSApp.postEvent(up, atStart: false) }
        window.sendEvent(down)
        settle()
        // A view that ignored the press leaves its release behind: it mustn't end the next drag.
        NSApp.discardEvents(matching: [.leftMouseDragged, .leftMouseUp], before: nil)
    }

    static func click(_ window: NSWindow, at p: NSPoint, clicks: Int = 1) {
        for c in 1...clicks { mouseDrag(window, from: p, to: p, steps: 0, clicks: c) }
    }

    /// The middle of a terminal cell, in window coordinates (the terminal's own metrics: DM Mono 12, 8 pt inset).
    static func cellPoint(_ view: NSView, row: Int, col: Int) -> NSPoint {
        let font = NSFont(name: "DMMono-Regular", size: 12) ?? .monospacedSystemFont(ofSize: 12, weight: .regular)
        let w = ceil(("M" as NSString).size(withAttributes: [.font: font]).width)
        let h = ceil(font.ascender - font.descender + font.leading) + 2
        return view.convert(NSPoint(x: 8 + CGFloat(col) * w + w / 2, y: 8 + CGFloat(row) * h + h / 2), to: nil)
    }

    static func terminalWindow(_ tab: TerminalTab, size: NSSize = NSSize(width: 460, height: 160)) -> (NSWindow, TerminalNSView) {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let window = KeyWindow(
            contentRect: NSRect(x: -20000, y: -20000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered,
            defer: false)
        window.alphaValue = 0
        let view = TerminalNSView(frame: NSRect(origin: .zero, size: size))
        view.tab = tab
        window.contentView = view
        window.orderFrontRegardless()
        window.makeKey()
        window.makeFirstResponder(view)
        settle()
        return (window, view)
    }

    static func terminalSelectionChecks(_ board: NSPasteboard, _ check: (String, Bool) -> Void) {
        let tab = TerminalTab(sample: "Terminal 1", output: "alpha beta gamma\r\nsecond line here\r\nthird", cols: 40, rows: 6)
        let (window, view) = terminalWindow(tab)
        defer { window.orderOut(nil) }
        let menu = editMenu()
        put(board, "untouched")
        mouseDrag(window, from: cellPoint(view, row: 0, col: 0), to: cellPoint(view, row: 1, col: 5))
        command(window, "c", code: 8, menu: menu)
        check("a drag in the Terminal and ⌘C copy what it went over", board.string(forType: .string) == "alpha beta gamma\nsecond")
        check("the drag highlights what it picked", terminalCellLit(view, row: 1, col: 2) && !terminalCellLit(view, row: 2, col: 2))
        put(board, "untouched")
        if let copy = menu.items.first(where: { $0.title == "Copy" }) { perform(copy, in: window) }
        check("Edit > Copy copies it too", board.string(forType: .string) == "alpha beta gamma\nsecond")
        put(board, "untouched")
        let context = rightClickMenu(at: cellPoint(view, row: 0, col: 3), in: window)
        if let copy = context?.items.first(where: { $0.title == "Copy" }) { perform(copy, in: window) }
        check("a right-click in the Terminal offers Copy, and it copies", board.string(forType: .string) == "alpha beta gamma\nsecond")
        put(board, "untouched")
        click(window, at: cellPoint(view, row: 0, col: 7), clicks: 2)
        command(window, "c", code: 8, menu: menu)
        check("a double-click picks a word", board.string(forType: .string) == "beta")
        put(board, "untouched")
        click(window, at: cellPoint(view, row: 1, col: 3), clicks: 3)
        command(window, "c", code: 8, menu: menu)
        check("a triple-click picks the line", board.string(forType: .string) == "second line here")
        put(board, "untouched")
        mouseDrag(window, from: cellPoint(view, row: 0, col: 6), to: cellPoint(view, row: 1, col: 9), flags: .option)
        command(window, "c", code: 8, menu: menu)
        check("an ⌥-drag picks a block of columns", board.string(forType: .string) == "beta\n lin")
    }

    /// Whether a cell's corner is drawn in the selection colour rather than the terminal's background.
    static func terminalCellLit(_ view: NSView, row: Int, col: Int) -> Bool {
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return false }
        view.cacheDisplay(in: view.bounds, to: rep)
        let mid = view.convert(cellPoint(view, row: row, col: col), from: nil)
        let scale = CGFloat(rep.pixelsWide) / view.bounds.width
        // A point near the cell's top left, clear of the letter.
        guard let c = rep.colorAt(x: Int((mid.x - 3) * scale), y: Int((mid.y - 6) * scale))?.usingColorSpace(.sRGB),
            let bg = TerminalColors.background.usingColorSpace(.sRGB)
        else { return false }
        return abs(c.redComponent - bg.redComponent) + abs(c.greenComponent - bg.greenComponent) + abs(c.blueComponent - bg.blueComponent) > 0.15
    }

    /// ⌘C with a selection copies and sends the shell nothing; ⌃C still interrupts what runs in it.
    static func terminalInterruptChecks(_ board: NSPasteboard, _ check: (String, Bool) -> Void) {
        guard let folder = scratchWorktree() else { return check("a scratch folder for the Terminal", false) }
        defer { try? FileManager.default.removeItem(atPath: folder) }
        let m = SessionsModel(preview: true)
        guard var s = m.sessions.first else { return check("the sample sessions load", false) }
        s.folder = folder
        s.archived = false
        let terms = Terminals()
        terms.shell = "/bin/sh"
        defer { terms.closeAll(s.id) }
        guard let tab = terms.open(s, env: [:], cols: 60, rows: 8) else { return check("a Terminal opens", false) }
        let (window, view) = terminalWindow(tab, size: NSSize(width: 600, height: 200))
        defer { window.orderOut(nil) }
        tab.write(Array("echo ready-to-copy\r".utf8))
        _ = waitFor(12) { (0..<tab.screen.rows).contains { tab.screen.line($0) == "ready-to-copy" } }
        settle()
        let row = (0..<tab.screen.rows).first { tab.screen.line($0) == "ready-to-copy" } ?? 1
        put(board, "untouched")
        click(window, at: cellPoint(view, row: row, col: 2), clicks: 2)
        command(window, "c", code: 8, menu: editMenu())
        _ = waitFor(1) { false }
        check("⌘C in the Terminal copies the selection", board.string(forType: .string) == "ready-to-copy")
        check("and never sends the shell ⌃C", !tab.screen.text.contains("^C"))
        tab.write(Array("sh -c 'trap \"echo caught-\\\"sig\\\"int; exit 0\" INT; while :; do sleep 0.2; done'\r".utf8))
        _ = waitFor(1) { false }
        if let e = keyboardEvent(8, down: true, flags: .control) { window.sendEvent(e) }
        if let e = keyboardEvent(8, down: false, flags: .control) { window.sendEvent(e) }
        check("⌃C still interrupts what runs in the Terminal", waitFor(10) { tab.screen.text.contains("caught-sigint") })
    }

    static let copySample = """
        First paragraph about the build.

        Second paragraph with **bold** words.

        - one item
        - two item

        ```swift
        let x = 1
        ```

        | Name | Value |
        |---|---|
        | alpha | 42 |

        Last paragraph after the table.
        """

    static func chatWindow(_ text: String, size: NSSize = NSSize(width: 700, height: 520)) -> NSWindow {
        offscreen(MessageText(text: text).frame(width: size.width, height: size.height, alignment: .topLeading), size: size)
    }

    /// A drag from the first word to past the last one, then ⌘C.
    static func chatSelectionChecks(_ board: NSPasteboard, _ check: (String, Bool) -> Void) {
        let window = chatWindow(copySample)
        defer { window.orderOut(nil) }
        put(board, "untouched")
        let h = window.frame.height
        mouseDrag(window, from: NSPoint(x: 2, y: h - 6), to: NSPoint(x: 690, y: 4), steps: 12)
        command(window, "c", code: 8, menu: editMenu())
        let copied = board.string(forType: .string) ?? ""
        let parts = [
            "First paragraph about the build.", "bold words", "one item", "two item", "let x = 1", "alpha", "42", "Last paragraph after the table.",
        ]
        check("a drag across a message's paragraphs, list, code and table copies all of it", parts.allSatisfy(copied.contains))
        check("as readable text (no Markdown marks, table cells kept apart)", !copied.contains("**") && copied.contains("alpha | 42"))
        let titles = rightClickMenu(at: NSPoint(x: 60, y: h - 10), in: window)?.items.map(\.title) ?? []
        check("a right-click on a message offers Copy and Copy as Markdown", titles.contains("Copy") && titles.contains("Copy as Markdown"))
    }

    static func button(_ id: String, in window: NSWindow) -> NSButton? {
        guard let content = window.contentView else { return nil }
        return views(NSButton.self, in: content).first { $0.identifier?.rawValue == id }
    }

    static func press(_ b: NSButton, in window: NSWindow) {
        click(window, at: b.convert(NSPoint(x: b.bounds.midX, y: b.bounds.midY), to: nil))
    }

    static func chatCopyButtonChecks(_ board: NSPasteboard, _ check: (String, Bool) -> Void) {
        let window = chatWindow(copySample)
        defer { window.orderOut(nil) }
        // Hovering the message shows its buttons.
        if let e = NSEvent.mouseEvent(
            with: .mouseMoved, location: NSPoint(x: 300, y: window.frame.height - 20), modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 0,
            pressure: 0)
        {
            window.sendEvent(e)
        }
        settle()
        put(board, "untouched")
        if let b = button("copy-message", in: window) { press(b, in: window) }
        let plain = board.string(forType: .string) ?? ""
        check(
            "a message's copy button copies its words as readable text",
            plain.hasPrefix("First paragraph about the build.") && plain.hasSuffix("Last paragraph after the table.") && !plain.contains("**"))
        check("and says Copied for a moment", button("copy-message", in: window)?.accessibilityLabel() == "Copied")
        put(board, "untouched")
        if let b = button("copy-markdown", in: window) { press(b, in: window) }
        check("Copy as Markdown copies the message as it was written", board.string(forType: .string) == copySample)
        put(board, "untouched")
        if let b = button("copy-code", in: window) { press(b, in: window) }
        check("a code block's copy button copies the code only", board.string(forType: .string) == "let x = 1")
        check("and says Copied too", button("copy-code", in: window)?.accessibilityLabel() == "Copied")
    }
}
