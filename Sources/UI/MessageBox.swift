import AppKit
import SwiftUI

/// The message box's text: AppKit's own NSTextView, so ⌘V, the Edit menu, the right-click menu, undo, dictation and
/// Accessibility insertion (Wispr Flow) work as in any Mac app. Forge adds only Enter to send (⌥Enter queues,
/// ⇧Enter is a new line) and its paste rule: a long text or a picture on the clipboard joins the message instead.
/// Nothing in the window claims ⌘V for it (a SwiftUI ⌘V button did, and swallowed every paste on the screen).
struct MessageBox: NSViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    /// Bumped to put the cursor in the box (⌘L).
    var focusRequest = 0
    let onReturn: (_ queue: Bool) -> Void
    /// A paste the message takes itself (true), or nil/false for AppKit's own paste.
    var onPaste: ((NSPasteboard) -> Bool)?

    static let maxHeight: CGFloat = 180

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        let tv = MessageTextView()
        tv.isRichText = false
        tv.importsGraphics = false
        tv.allowsUndo = true
        tv.drawsBackground = false
        tv.font = Theme.sansFont(13)
        tv.textColor = NSColor(Theme.text)
        tv.insertionPointColor = NSColor(Theme.text)
        tv.typingAttributes = [.font: Theme.sansFont(13), .foregroundColor: NSColor(Theme.text)]
        tv.textContainerInset = .zero
        tv.minSize = .zero
        tv.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
        tv.isVerticallyResizable = true
        tv.isHorizontallyResizable = false
        tv.autoresizingMask = [.width]
        tv.textContainer?.widthTracksTextView = true
        tv.isAutomaticQuoteSubstitutionEnabled = false
        tv.isAutomaticDashSubstitutionEnabled = false
        tv.setAccessibilityIdentifier("message-box")
        tv.delegate = context.coordinator
        tv.string = text
        // Every change reaches the draft, whoever makes it: typing, paste, undo, dictation, Accessibility.
        tv.textStorage?.delegate = context.coordinator
        scroll.documentView = tv
        context.coordinator.wire(tv)
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.box = self
        guard let tv = scroll.documentView as? MessageTextView else { return }
        context.coordinator.wire(tv)
        // A typed letter that isn't committed yet (an input method's marked text) stays until it is.
        if tv.string != text, !tv.hasMarkedText() {
            // Changed from outside (sent, a skill picked, review comments pulled in): undo starts over from here.
            tv.undoManager?.removeAllActions(withTarget: tv)
            if let storage = tv.textStorage { tv.undoManager?.removeAllActions(withTarget: storage) }
            tv.string = text
            tv.setSelectedRange(NSRange(location: (text as NSString).length, length: 0))
        }
        if focusRequest != context.coordinator.focusRequest {
            context.coordinator.focusRequest = focusRequest
            DispatchQueue.main.async { tv.window?.makeFirstResponder(tv) }
        }
    }

    /// Grows with its lines, from the frame's minimum up to `maxHeight`, then scrolls.
    func sizeThatFits(_ proposal: ProposedViewSize, nsView scroll: NSScrollView, context: Context) -> CGSize? {
        // An unlimited width (a stack weighing its children) is measured like no width, never returned as the size.
        let width = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? max(scroll.frame.width, 300)
        let padding = 2 * ((scroll.documentView as? NSTextView)?.textContainer?.lineFragmentPadding ?? 5)
        // A last empty line still takes a line.
        let measured = text.isEmpty || text.hasSuffix("\n") ? text + " " : text
        let height = (measured as NSString).boundingRect(
            with: NSSize(width: max(width - padding, 10), height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: Theme.sansFont(13)]
        ).height
        return CGSize(width: width, height: min(ceil(height), Self.maxHeight))
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate, NSTextStorageDelegate {
        var box: MessageBox
        var focusRequest: Int

        init(_ box: MessageBox) {
            self.box = box
            self.focusRequest = box.focusRequest
        }

        func wire(_ tv: MessageTextView) {
            tv.onReturn = { [weak self] queue in self?.box.onReturn(queue) }
            tv.onPaste = { [weak self] board in self?.box.onPaste?(board) ?? false }
            tv.onFocus = { [weak self] on in
                // Told after AppKit's change, never during SwiftUI's own update.
                DispatchQueue.main.async { if self?.box.focused != on { self?.box.focused = on } }
            }
        }

        func textDidChange(_ note: Notification) {
            guard let tv = note.object as? NSTextView else { return }
            if box.text != tv.string { box.text = tv.string }
        }

        nonisolated func textStorage(
            _ storage: NSTextStorage, didProcessEditing edited: NSTextStorageEditActions, range: NSRange, changeInLength delta: Int
        ) {
            guard edited.contains(.editedCharacters) else { return }
            let now = storage.string
            MainActor.assumeIsolated {
                // After AppKit finishes the edit (an undo doesn't always tell the text view's delegate).
                DispatchQueue.main.async { if self.box.text != now, storage.string == now { self.box.text = now } }
            }
        }
    }
}

/// The text view behind `MessageBox`.
final class MessageTextView: NSTextView {
    var onReturn: ((Bool) -> Void)?
    var onPaste: ((NSPasteboard) -> Bool)?
    var onFocus: ((Bool) -> Void)?

    override func keyDown(with event: NSEvent) {
        let returnKey = event.keyCode == 36 || event.keyCode == 76
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if returnKey, !hasMarkedText(), !mods.contains(.shift), !mods.contains(.command), !mods.contains(.control) {
            onReturn?(mods.contains(.option))
            return
        }
        super.keyDown(with: event)
    }

    override func paste(_ sender: Any?) {
        if onPaste?(NSPasteboard.general) == true { return }
        super.paste(sender)
    }

    /// Paste stays on with only a picture on the clipboard (a plain-text view would grey it out); `onPaste` takes it.
    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(paste(_:)), isEditable, onPaste != nil,
            NSPasteboard.general.availableType(from: [.png, .tiff, .fileURL]) != nil
        {
            return true
        }
        return super.validateUserInterfaceItem(item)
    }

    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok { onFocus?(true) }
        return ok
    }

    override func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        if ok { onFocus?(false) }
        return ok
    }
}
