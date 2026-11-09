import AppKit
import SwiftUI

/// A plain-text editor for the workflow file: mono, line numbers in the margin, problem lines tinted red, and a
/// jump to a line when a problem is clicked. AppKit's text view, since SwiftUI's has no lines to mark.
struct CodeEditor: NSViewRepresentable {
    @Binding var text: String
    /// 1-based lines with a problem.
    var marked: Set<Int>
    /// Set to scroll to and select a line; cleared once done.
    @Binding var jump: Int?

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.drawsBackground = true
        scroll.backgroundColor = NSColor(Theme.bg)
        scroll.borderType = .noBorder
        guard let view = scroll.documentView as? NSTextView else { return scroll }
        view.isRichText = false
        view.allowsUndo = true
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticTextReplacementEnabled = false
        view.isAutomaticSpellingCorrectionEnabled = false
        view.isContinuousSpellCheckingEnabled = false
        view.font = Self.font
        view.textColor = NSColor(Theme.text)
        view.backgroundColor = NSColor(Theme.bg)
        view.insertionPointColor = NSColor(Theme.heatBright)
        view.textContainerInset = NSSize(width: 8, height: 12)
        view.string = text
        view.delegate = context.coordinator
        let ruler = LineRuler(textView: view)
        scroll.verticalRulerView = ruler
        scroll.hasVerticalRuler = true
        scroll.rulersVisible = true
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let view = scroll.documentView as? NSTextView else { return }
        if view.string != text { view.string = text }
        mark(view)
        (scroll.verticalRulerView as? LineRuler)?.marked = marked
        scroll.verticalRulerView?.needsDisplay = true
        if let line = jump, let range = Self.range(ofLine: line, in: view.string) {
            view.scrollRangeToVisible(range)
            view.setSelectedRange(range)
            view.window?.makeFirstResponder(view)
            DispatchQueue.main.async { jump = nil }
        }
    }

    private func mark(_ view: NSTextView) {
        guard let lm = view.layoutManager else { return }
        let all = NSRange(location: 0, length: (view.string as NSString).length)
        lm.removeTemporaryAttribute(.backgroundColor, forCharacterRange: all)
        for line in marked {
            if let r = Self.range(ofLine: line, in: view.string) {
                lm.addTemporaryAttribute(.backgroundColor, value: NSColor(Theme.bad).withAlphaComponent(0.28), forCharacterRange: r)
            }
        }
    }

    static let font = NSFont(name: "DMMono-Regular", size: 12) ?? .monospacedSystemFont(ofSize: 12, weight: .regular)

    /// The characters of a 1-based line.
    static func range(ofLine line: Int, in text: String) -> NSRange? {
        let ns = text as NSString
        var n = 1
        var at = 0
        while n < line {
            let r = ns.range(of: "\n", range: NSRange(location: at, length: ns.length - at))
            if r.location == NSNotFound { return nil }
            at = r.location + 1
            n += 1
        }
        return ns.lineRange(for: NSRange(location: min(at, ns.length), length: 0))
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: CodeEditor
        init(_ parent: CodeEditor) { self.parent = parent }

        func textDidChange(_ note: Notification) {
            guard let view = note.object as? NSTextView else { return }
            parent.text = view.string
            view.enclosingScrollView?.verticalRulerView?.needsDisplay = true
        }
    }
}

/// Line numbers beside the text, problem lines in red.
final class LineRuler: NSRulerView {
    var marked: Set<Int> = []
    private weak var textView: NSTextView?

    init(textView: NSTextView) {
        self.textView = textView
        super.init(scrollView: textView.enclosingScrollView, orientation: .verticalRuler)
        clientView = textView
        ruleThickness = 44
    }

    required init(coder: NSCoder) { fatalError("not used") }

    override func drawHashMarksAndLabels(in rect: NSRect) {
        guard let view = textView, let lm = view.layoutManager, let tc = view.textContainer else { return }
        NSColor(Theme.surface).setFill()
        bounds.fill()
        let ns = view.string as NSString
        let visible = lm.glyphRange(forBoundingRect: view.visibleRect, in: tc)
        let firstChar = lm.characterIndexForGlyph(at: visible.location)
        var line = ns.substring(to: firstChar).reduce(1) { $1 == "\n" ? $0 + 1 : $0 }
        var index = firstChar
        let font = NSFont(name: "DMMono-Regular", size: 10) ?? .monospacedDigitSystemFont(ofSize: 10, weight: .regular)
        let end = NSMaxRange(lm.characterRange(forGlyphRange: visible, actualGlyphRange: nil))
        while index <= end, index <= ns.length {
            let lineRange = ns.lineRange(for: NSRange(location: min(index, ns.length), length: 0))
            let glyphs = lm.glyphRange(forCharacterRange: NSRange(location: lineRange.location, length: 0), actualCharacterRange: nil)
            var frag = lm.lineFragmentRect(forGlyphAt: min(glyphs.location, max(0, lm.numberOfGlyphs - 1)), effectiveRange: nil)
            if ns.length == 0 || index == ns.length { frag = lm.extraLineFragmentRect.isEmpty ? frag : lm.extraLineFragmentRect }
            let y = convert(NSPoint(x: 0, y: frag.minY + view.textContainerInset.height), from: view).y
            let color = marked.contains(line) ? NSColor(Theme.bad).blended(withFraction: 0.45, of: .white) ?? .red : NSColor(Theme.textMuted)
            let label = "\(line)" as NSString
            let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
            let size = label.size(withAttributes: attrs)
            label.draw(at: NSPoint(x: ruleThickness - size.width - 8, y: y + (frag.height - size.height) / 2), withAttributes: attrs)
            if NSMaxRange(lineRange) <= index { break }
            index = NSMaxRange(lineRange)
            line += 1
            if index == ns.length, !ns.hasSuffix("\n") { break }
        }
    }
}
