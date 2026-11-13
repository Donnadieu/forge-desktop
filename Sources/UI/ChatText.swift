import AppKit
import SwiftUI

/// A message drawn by `RichText` in one AppKit text view: a drag selects across its paragraphs, lists, code and
/// tables, and ⌘C, Edit > Copy and right-click Copy copy readable text. On hover the message shows Copy and Copy as
/// Markdown; each code block has its own Copy (the code only). Each says Copied for a moment.
struct RichMessage: NSViewRepresentable {
    let text: String
    let parts: [MarkdownPart]
    let key: Int
    /// Takes the whole width (the agent's words); a bubble sizes to its text.
    var fill = true
    /// Read where the message is built, so a zoom change draws and measures it again.
    var zoom = Zoom.shared.level
    /// The message at this zoom.
    private var zoomedKey: Int { RichText.zoomed(key) }

    func makeNSView(context: Context) -> ChatTextView {
        // TextKit 1: AppKit draws code panels and tables (text blocks) only there.
        let v = ChatTextView(usingTextLayoutManager: false)
        v.setUp()
        update(v, context: context)
        return v
    }

    func updateNSView(_ v: ChatTextView, context: Context) { update(v, context: context) }

    private func update(_ v: ChatTextView, context: Context) {
        let open = context.environment.openURL
        v.onLink = { open($0) }
        if v.key != zoomedKey { v.show(RichText.build(parts, key: zoomedKey), source: text, key: zoomedKey) }
    }

    /// Sizes already measured, by message and width (a list asks for a row's size many times).
    @MainActor private static var sizes: [Int: NSSize] = [:]

    func sizeThatFits(_ proposal: ProposedViewSize, nsView v: ChatTextView, context: Context) -> CGSize? {
        // A stack weighing its children or a sideways scroll asks at an unlimited width: measure that like no width
        // (0.2.41 turned it into a whole number below and crashed opening a chat).
        let asked = proposal.width ?? 600
        let width = asked.isFinite ? min(max(asked, 60), 20_000) : 600
        var h = Hasher()
        h.combine(zoomedKey)
        h.combine(Int(width))
        let sizeKey = h.finalize()
        let used: NSSize
        if let hit = Self.sizes[sizeKey] {
            used = hit
        } else {
            if v.key != zoomedKey { v.show(RichText.build(parts, key: zoomedKey), source: text, key: zoomedKey) }
            used = v.measure(width: width)
            if Self.sizes.count > 5000 { Self.sizes.removeAll() }
            Self.sizes[sizeKey] = used
        }
        let w = fill ? width : min(width, ceil(used.width) + ChatTextView.buttonsWidth)
        return CGSize(width: w, height: max(ceil(used.height), ChatTextView.buttonsHeight))
    }
}

final class ChatTextView: NSTextView, NSTextViewDelegate {
    static let buttonsWidth: CGFloat = 52
    static let buttonsHeight: CGFloat = 20

    private(set) var key = 0
    private var source = ""
    private var codes: [String] = []
    private var codeButtons: [NSButton] = []
    private let copyButton = ChatTextView.iconButton("doc.on.doc", label: "Copy", id: "copy-message")
    private let markdownButton = ChatTextView.iconButton("text.badge.checkmark", label: "Copy as Markdown", id: "copy-markdown")
    var onLink: ((URL) -> Void)?

    static func iconButton(_ symbol: String, label: String, id: String) -> NSButton {
        let b = NSButton(frame: NSRect(x: 0, y: 0, width: 22, height: 20))
        b.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
        b.isBordered = false
        b.imageScaling = .scaleProportionallyDown
        b.contentTintColor = NSColor(Theme.textMuted)
        b.identifier = NSUserInterfaceItemIdentifier(id)
        b.toolTip = label
        b.setAccessibilityLabel(label)
        return b
    }

    func setUp() {
        isEditable = false
        isSelectable = true
        isRichText = true
        drawsBackground = false
        textContainerInset = .zero
        textContainer?.lineFragmentPadding = 0
        textContainer?.widthTracksTextView = true
        isVerticallyResizable = false
        isHorizontallyResizable = false
        delegate = self
        linkTextAttributes = [
            .foregroundColor: NSColor(Theme.heatBright), .underlineStyle: NSUnderlineStyle.single.rawValue, .cursor: NSCursor.pointingHand,
        ]
        selectedTextAttributes = [.backgroundColor: NSColor(Theme.heat).withAlphaComponent(0.35)]
        for b in [copyButton, markdownButton] {
            b.target = self
            b.alphaValue = 0
            addSubview(b)
        }
        copyButton.action = #selector(copyMessage(_:))
        markdownButton.action = #selector(copyMarkdown(_:))
    }

    func show(_ built: RichText.Built, source: String, key: Int) {
        self.key = key
        self.source = source
        codes = built.codes
        textStorage?.setAttributedString(built.text)
        codeButtons.forEach { $0.removeFromSuperview() }
        codeButtons = codes.indices.map { i in
            let b = Self.iconButton("doc.on.doc", label: "Copy code", id: "copy-code")
            b.tag = i
            b.target = self
            b.action = #selector(copyCode(_:))
            b.alphaValue = 0.7
            addSubview(b)
            return b
        }
        needsLayout = true
    }

    /// The text's size at a width, with room kept at the top right for the message's buttons.
    func measure(width: CGFloat) -> NSSize {
        guard let container = textContainer, let layout = layoutManager else { return .zero }
        container.size = NSSize(width: width, height: .greatestFiniteMagnitude)
        container.exclusionPaths = [
            NSBezierPath(rect: NSRect(x: width - Self.buttonsWidth, y: 0, width: Self.buttonsWidth, height: Self.buttonsHeight))
        ]
        layout.ensureLayout(for: container)
        return layout.usedRect(for: container).size
    }

    override func layout() {
        super.layout()
        let w = bounds.width
        textContainer?.exclusionPaths = [
            NSBezierPath(rect: NSRect(x: w - Self.buttonsWidth, y: 0, width: Self.buttonsWidth, height: Self.buttonsHeight))
        ]
        markdownButton.frame = NSRect(x: w - 22, y: 0, width: 22, height: 20)
        copyButton.frame = NSRect(x: w - 46, y: 0, width: 22, height: 20)
        placeCodeButtons()
    }

    private func placeCodeButtons() {
        guard let storage = textStorage, let layout = layoutManager, let container = textContainer else { return }
        layout.ensureLayout(for: container)
        var seen = Set<Int>()
        storage.enumerateAttribute(RichText.codeKey, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
            guard let i = value as? Int, !seen.contains(i), codeButtons.indices.contains(i) else { return }
            seen.insert(i)
            // The block spans the width; its first line sits under its 10 pt padding.
            let glyphs = layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            let lines = layout.boundingRect(forGlyphRange: glyphs, in: container)
            codeButtons[i].frame = NSRect(x: bounds.width - 30, y: max(lines.minY - 8, 0), width: 22, height: 20)
        }
    }

    // Hover shows the message's buttons.
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.filter { $0.owner === self && $0.userInfo?["hover"] != nil }.forEach(removeTrackingArea)
        addTrackingArea(
            NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: ["hover": true]))
    }

    override func mouseEntered(with event: NSEvent) {
        super.mouseEntered(with: event)
        [copyButton, markdownButton].forEach { $0.alphaValue = 1 }
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        [copyButton, markdownButton].forEach { $0.alphaValue = 0 }
    }

    /// A press picks text (or follows a link) even while Forge's window is in the back.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private func put(_ s: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
    }

    /// ⌘C, Edit > Copy and right-click Copy: readable text (tables as `a | b`), not the drawn blocks.
    override func copy(_ sender: Any?) {
        let r = selectedRange()
        guard r.length > 0, let storage = textStorage else { return }
        put(RichText.plain(storage, range: r))
    }

    @objc func copyMessage(_ sender: NSButton) {
        guard let storage = textStorage else { return }
        put(RichText.plain(storage, range: NSRange(location: 0, length: storage.length)))
        flash(sender)
    }

    @objc func copyMarkdown(_ sender: Any?) {
        put(source)
        if let b = sender as? NSButton { flash(b) }
    }

    @objc func copyCode(_ sender: NSButton) {
        guard codes.indices.contains(sender.tag) else { return }
        put(codes[sender.tag])
        flash(sender)
    }

    /// The button shows a check and says Copied for a moment.
    private func flash(_ b: NSButton) {
        let image = b.image
        let label = b.accessibilityLabel()
        b.image = NSImage(systemSymbolName: "checkmark", accessibilityDescription: "Copied")
        b.contentTintColor = NSColor(Theme.heatBright)
        b.setAccessibilityLabel("Copied")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak b] in
            b?.image = image
            b?.contentTintColor = NSColor(Theme.textMuted)
            b?.setAccessibilityLabel(label)
        }
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = super.menu(for: event) ?? NSMenu()
        menu.insertItem(NSMenuItem(title: "Copy as Markdown", action: #selector(copyMarkdown(_:)), keyEquivalent: ""), at: 0)
        menu.insertItem(.separator(), at: 1)
        return menu
    }

    func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
        guard let url = (link as? URL) ?? (link as? String).flatMap(URL.init(string:)) else { return false }
        onLink?(url)
        return true
    }
}
