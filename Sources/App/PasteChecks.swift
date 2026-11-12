import AppKit
import SwiftUI

/// Selftest checks for pasting and editing in the message box and the other fields on the Sessions screen (Omar,
/// Nov 12: ⌘V, Wispr Flow and right-click did nothing in the box). Real key events go the way AppKit sends a ⌘ key
/// (the key window's views first, then the menu bar's Edit menu, then keyDown), a real right-click opens the text
/// menu (caught before it reaches the screen), and Accessibility insertion is what dictation apps do. The person's
/// clipboard is never touched: AppKit's own paste reads a private pasteboard standing in for the general one.
@MainActor
extension Checks {
    static func pasteChecks(_ check: (String, Bool) -> Void) {
        let ran = withPrivateClipboard { board in
            boxPasteChecks(board, check)
            fieldPasteChecks(board, check)
            terminalPasteChecks(board, check)
        }
        if !ran { check("a private clipboard stands in for the real one", false) }
    }

    /// The general pasteboard, swapped for a private one while `body` runs (false if it couldn't be swapped, and then
    /// `body` never runs, so a check can't reach the real clipboard).
    @discardableResult
    static func withPrivateClipboard(_ body: (NSPasteboard) -> Void) -> Bool {
        let board = NSPasteboard(name: NSPasteboard.Name("forge-selftest-clip-\(UUID().uuidString.prefix(6))"))
        guard let method = class_getClassMethod(NSPasteboard.self, NSSelectorFromString("generalPasteboard")) else { return false }
        let original = method_getImplementation(method)
        let swap: @convention(block) (AnyObject) -> NSPasteboard = { _ in board }
        method_setImplementation(method, imp_implementationWithBlock(swap))
        defer {
            method_setImplementation(method, original)
            board.releaseGlobally()
        }
        guard NSPasteboard.general === board else { return false }
        body(board)
        return true
    }

    static func put(_ board: NSPasteboard, _ text: String) {
        board.clearContents()
        board.setString(text, forType: .string)
    }

    /// The Edit menu every Mac app has (SwiftUI's has these items, actions and keys).
    static func editMenu() -> NSMenu {
        let edit = NSMenu(title: "Edit")
        for (title, action, key, shift) in [
            ("Undo", "undo:", "z", false), ("Redo", "redo:", "z", true), ("Cut", "cut:", "x", false), ("Copy", "copy:", "c", false),
            ("Paste", "paste:", "v", false), ("Select All", "selectAll:", "a", false),
        ] {
            let item = NSMenuItem(title: title, action: NSSelectorFromString(action), keyEquivalent: key)
            item.keyEquivalentModifierMask = shift ? [.command, .shift] : .command
            edit.addItem(item)
        }
        return edit
    }

    /// What the menu bar does with an item: its action goes up the key window's responder chain to the first object
    /// that takes it, if that object says the item is enabled (a check has no key window for AppKit to find).
    @discardableResult
    static func perform(_ item: NSMenuItem, in window: NSWindow) -> Bool {
        guard let action = item.action else { return false }
        var next: NSResponder? = window.firstResponder
        while let r = next {
            if r.responds(to: action) {
                if let v = r as? NSUserInterfaceValidations, !v.validateUserInterfaceItem(item) { return false }
                return NSApp.sendAction(action, to: r, from: item)
            }
            next = r.nextResponder
        }
        return false
    }

    /// A key event as the keyboard makes it: built from a CGEvent, so SwiftUI reads the same modifiers AppKit does
    /// (`NSEvent.keyEvent(...)` has no CGEvent behind it, and SwiftUI then matches ⌘A to a ⇧⌘A shortcut).
    static func keyboardEvent(_ code: UInt16, down: Bool, flags: NSEvent.ModifierFlags) -> NSEvent? {
        guard let cg = CGEvent(keyboardEventSource: CGEventSource(stateID: .privateState), virtualKey: code, keyDown: down) else { return nil }
        var f: CGEventFlags = []
        if flags.contains(.command) { f.insert(.maskCommand) }
        if flags.contains(.shift) { f.insert(.maskShift) }
        if flags.contains(.option) { f.insert(.maskAlternate) }
        if flags.contains(.control) { f.insert(.maskControl) }
        cg.flags = f
        return NSEvent(cgEvent: cg)
    }

    /// A ⌘ key the way AppKit routes it (`-[NSApplication _handleKeyEquivalent:]`): the key window's views first
    /// (SwiftUI's keyboard shortcuts live there), then the menu bar, then a plain keyDown to the first responder.
    static func command(_ window: NSWindow, _ c: String, code: UInt16, shift: Bool = false, menu: NSMenu) {
        let flags: NSEvent.ModifierFlags = shift ? [.command, .shift] : .command
        if let e = keyboardEvent(code, down: true, flags: flags) {
            if window.performKeyEquivalent(with: e) {
                // Taken by a SwiftUI shortcut on the screen.
            } else if let item = menu.items.first(where: { $0.keyEquivalent == c && $0.keyEquivalentModifierMask == flags }),
                perform(item, in: window)
            {
                // Done by the Edit menu.
            } else {
                window.sendEvent(e)
            }
        }
        if let up = keyboardEvent(code, down: false, flags: flags) { window.sendEvent(up) }
        settle()
    }

    /// Catches the menu a right-click opens, so it never reaches the screen.
    final class MenuCatcher: NSObject {
        nonisolated(unsafe) static var caught: NSMenu?
    }

    /// The menu a real right-click at `point` (window coordinates) opens, or nil. Without the catch in place it
    /// sends no click at all (a real menu would show on the person's screen).
    static func rightClickMenu(at point: NSPoint, in window: NSWindow) -> NSMenu? {
        let sel = NSSelectorFromString("_popUpMenuWithEvent:forView:")
        guard let method = class_getInstanceMethod(NSMenu.self, sel),
            let ctx = class_getClassMethod(NSMenu.self, #selector(NSMenu.popUpContextMenu(_:with:for:))),
            let ctxFont = class_getClassMethod(NSMenu.self, #selector(NSMenu.popUpContextMenu(_:with:for:with:)))
        else { return nil }
        typealias Own = @convention(block) (NSMenu, AnyObject?, AnyObject?) -> Void
        typealias Ctx = @convention(block) (AnyObject, NSMenu, AnyObject?, AnyObject?) -> Void
        typealias CtxFont = @convention(block) (AnyObject, NSMenu, AnyObject?, AnyObject?, AnyObject?) -> Void
        let own: Own = { menu, _, _ in MenuCatcher.caught = menu }
        let shown: Ctx = { _, menu, _, _ in MenuCatcher.caught = menu }
        let shownFont: CtxFont = { _, menu, _, _, _ in MenuCatcher.caught = menu }
        let saved = [(method, method_getImplementation(method)), (ctx, method_getImplementation(ctx)), (ctxFont, method_getImplementation(ctxFont))]
        method_setImplementation(method, imp_implementationWithBlock(own))
        method_setImplementation(ctx, imp_implementationWithBlock(shown))
        method_setImplementation(ctxFont, imp_implementationWithBlock(shownFont))
        defer { for (m, imp) in saved { method_setImplementation(m, imp) } }
        MenuCatcher.caught = nil
        func mouse(_ type: NSEvent.EventType, _ n: Int) -> NSEvent? {
            NSEvent.mouseEvent(
                with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: n, clickCount: 1, pressure: type == .rightMouseDown ? 1 : 0)
        }
        // The release waits in the queue first, as a press may track the mouse until it's let go.
        if let down = mouse(.rightMouseDown, 9001), let up = mouse(.rightMouseUp, 9002) {
            NSApp.postEvent(up, atStart: false)
            window.sendEvent(down)
        }
        settle()
        // The menu never tracked the mouse, so its release is still waiting.
        NSApp.discardEvents(matching: [.rightMouseUp], before: nil)
        return MenuCatcher.caught
    }

    /// An off-screen window holding `view` that can take the keyboard, and the text views in it.
    static func offscreen<V: View>(_ view: V, size: NSSize) -> NSWindow {
        let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height))
        host.frame = NSRect(origin: .zero, size: size)
        NSApplication.shared.setActivationPolicy(.prohibited)
        let window = KeyWindow(
            contentRect: NSRect(x: -20000, y: -20000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered,
            defer: false)
        window.alphaValue = 0
        window.contentView = host
        window.orderFrontRegardless()
        window.makeKey()
        settle()
        return window
    }

    static func views<T: NSView>(_ type: T.Type, in view: NSView) -> [T] {
        ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap { views(type, in: $0) }
    }

    /// The message box's text view (not a field's shared field editor).
    static func messageBox(in window: NSWindow) -> NSTextView? {
        guard let content = window.contentView else { return nil }
        return views(NSTextView.self, in: content).last { $0.isEditable && !$0.isFieldEditor }
    }

    static func sessionsScreenModel() -> AppModel? {
        guard let shot = ScreenRender.shots().first(where: { $0.name == "14-sessions-chat" }) else { return nil }
        return ScreenRender.model(for: shot)
    }

    static func boxPasteChecks(_ board: NSPasteboard, _ check: (String, Bool) -> Void) {
        guard let model = sessionsScreenModel(), let s = model.sessions.current, let chat = model.sessions.activeChat(of: s) else {
            return check("the sample Sessions screen", false)
        }
        let m = model.sessions
        m.drafts[chat.id] = ""
        let window = offscreen(SessionsScreen(model: model, sessions: m), size: NSSize(width: 1500, height: 870))
        defer { window.orderOut(nil) }
        guard let box = messageBox(in: window) else { return check("the message box has a text view", false) }
        window.makeFirstResponder(box)
        settle()
        let menu = editMenu()
        let draft = { m.drafts[chat.id] ?? "" }

        put(board, "pasted words")
        command(window, "v", code: 9, menu: menu)
        check("⌘V pastes the clipboard's text into the message box", draft() == "pasted words" && box.string == "pasted words")
        // The rest starts from typed words, so each key is checked on its own.
        m.drafts[chat.id] = ""
        settle()
        box.insertText("typed words", replacementRange: NSRange(location: NSNotFound, length: 0))
        settle()
        command(window, "z", code: 6, menu: menu)
        let undone = draft().isEmpty
        check("⌘Z undoes typing", undone)
        command(window, "z", code: 6, shift: true, menu: menu)
        check("⇧⌘Z redoes it", undone && draft() == "typed words")
        command(window, "a", code: 0, menu: menu)
        check("⌘A selects everything in the box", box.selectedRange() == NSRange(location: 0, length: (box.string as NSString).length))
        put(board, "something else")
        command(window, "c", code: 8, menu: menu)
        check("⌘C copies the selection", board.string(forType: .string) == "typed words")
        put(board, "something else")
        command(window, "x", code: 7, menu: menu)
        check("⌘X cuts it", draft().isEmpty && board.string(forType: .string) == "typed words")

        put(board, "from the menu")
        if let paste = menu.items.first(where: { $0.title == "Paste" }) { perform(paste, in: window) }
        settle()
        check("Edit > Paste pastes", draft() == "from the menu")

        m.drafts[chat.id] = ""
        settle()
        put(board, "right-clicked")
        let at = box.convert(NSPoint(x: box.visibleRect.minX + 30, y: box.visibleRect.midY), to: nil)
        let context = rightClickMenu(at: at, in: window)
        let titles = context?.items.map(\.title) ?? []
        check("a right-click on the box opens the text menu (Cut, Copy, Paste)", ["Cut", "Copy", "Paste"].allSatisfy(titles.contains))
        if let paste = context?.items.first(where: { $0.title == "Paste" }) { perform(paste, in: window) }
        settle()
        check("its Paste pastes", draft() == "right-clicked")

        // Dictation apps (Wispr Flow, macOS dictation) insert through Accessibility or the text input system.
        m.drafts[chat.id] = ""
        settle()
        box.setSelectedRange(NSRange(location: 0, length: 0))
        box.setAccessibilitySelectedText("said out loud")
        settle()
        check("text inserted through Accessibility lands in the box", draft() == "said out loud")
        box.insertText(" and dictated", replacementRange: NSRange(location: NSNotFound, length: 0))
        settle()
        check("text inserted by dictation lands in the box", draft() == "said out loud and dictated")
        box.setAccessibilityValue("replaced by voice")
        settle()
        check("a dictation app setting the box's whole value works", draft() == "replaced by voice")

        m.drafts[chat.id] = ""
        m.texts[chat.id] = nil
        settle()
        let long = String(repeating: "a line from a long log\n", count: 200)
        put(board, long)
        command(window, "v", code: 9, menu: menu)
        let chips = m.texts[chat.id] ?? []
        check("a ⌘V over 4,000 characters still becomes a .txt chip", chips.count == 1 && chips.first?.text == long && draft().isEmpty)
        m.texts[chat.id] = nil
        m.images[chat.id] = nil
        board.clearContents()
        board.setData(samplePNG(), forType: .png)
        command(window, "v", code: 9, menu: menu)
        check("a picture on the clipboard still joins the message", (m.images[chat.id] ?? []).count == 1 && draft().isEmpty)
        m.images[chat.id] = nil
    }

    static func samplePNG() -> Data {
        let image = NSImage(size: NSSize(width: 4, height: 4))
        image.lockFocus()
        NSColor.orange.setFill()
        NSRect(x: 0, y: 0, width: 4, height: 4).fill()
        image.unlockFocus()
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return Data() }
        return rep.representation(using: .png, properties: [:]) ?? Data()
    }

    /// Any other field on the same screen (the session search) pastes too: the message box doesn't take ⌘V for the
    /// whole window.
    static func fieldPasteChecks(_ board: NSPasteboard, _ check: (String, Bool) -> Void) {
        guard let model = sessionsScreenModel() else { return check("the sample Sessions screen", false) }
        let window = offscreen(SessionsScreen(model: model, sessions: model.sessions), size: NSSize(width: 1500, height: 870))
        defer { window.orderOut(nil) }
        guard let content = window.contentView, let field = views(NSTextField.self, in: content).first(where: { $0.isEditable }) else {
            return check("the Sessions screen has a search field", false)
        }
        window.makeFirstResponder(field)
        settle()
        put(board, "find me")
        command(window, "v", code: 9, menu: editMenu())
        let typed = (field.currentEditor() as? NSTextView)?.string ?? field.stringValue
        check("⌘V pastes into the other fields on the Sessions screen", typed == "find me")
    }

    /// The session's Terminal has its own paste (into the shell): ⌘V reaches it with the message box on screen.
    static func terminalPasteChecks(_ board: NSPasteboard, _ check: (String, Bool) -> Void) {
        guard let folder = scratchWorktree(), let model = sessionsScreenModel(), var s = model.sessions.current,
            let i = model.sessions.sessions.firstIndex(where: { $0.id == s.id })
        else { return check("a session with a folder for the Terminal", false) }
        defer { try? FileManager.default.removeItem(atPath: folder) }
        s.folder = folder
        s.archived = false
        model.sessions.sessions[i] = s
        let terms = Terminals()
        terms.shell = "/bin/sh"
        let shared = Terminals.shared
        Terminals.shared = terms
        defer {
            terms.closeAll(s.id)
            Terminals.shared = shared
        }
        guard let tab = terms.open(s, env: [:]) else { return check("a Terminal opens", false) }
        terms.shown.insert(s.id)
        // A CI Mac can take seconds to start a login shell.
        _ = waitFor(12) { !tab.screen.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        let window = offscreen(SessionsScreen(model: model, sessions: model.sessions), size: NSSize(width: 1500, height: 900))
        defer { window.orderOut(nil) }
        guard let content = window.contentView, let term = views(TerminalNSView.self, in: content).first else {
            return check("the Terminal panel is on screen", false)
        }
        window.makeFirstResponder(term)
        settle()
        put(board, "echo pasted-into-the-shell")
        command(window, "v", code: 9, menu: editMenu())
        check("⌘V pastes into the session's Terminal", waitFor(10) { tab.screen.text.contains("echo pasted-into-the-shell") })
    }
}
