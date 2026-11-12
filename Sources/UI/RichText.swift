import AppKit
import SwiftUI

/// A message's Markdown blocks as one AppKit text, so a drag can run across paragraphs, lists, code and tables and
/// copy them in one go. Headings, lists and inline Markdown look as before; a code block is a mono panel and a table
/// a grid of cells (both AppKit text blocks). Each code block and table cell is marked, so a copy turns it back into
/// readable text (`RichText.plain`). Built once per text and kept.
@MainActor
enum RichText {
    /// Marks a table cell: its table, row and column.
    static let cellKey = NSAttributedString.Key("forge.cell")
    /// Marks a code block's text with its index in the message.
    static let codeKey = NSAttributedString.Key("forge.code")
    /// Marks a list item.
    static let itemKey = NSAttributedString.Key("forge.item")
    /// Marks a thin empty line that keeps a code panel or table off what's above it (not copied).
    static let spacerKey = NSAttributedString.Key("forge.spacer")

    private static var spacer: NSAttributedString {
        let style = NSMutableParagraphStyle()
        style.maximumLineHeight = 6
        style.minimumLineHeight = 6
        return NSAttributedString(string: "\n", attributes: [.font: Theme.sansFont(4), .paragraphStyle: style, spacerKey: true])
    }

    struct Built {
        let text: NSAttributedString
        /// Each code block's own text, in order.
        let codes: [String]
    }

    private static var cache: [Int: Built] = [:]

    static func build(_ parts: [MarkdownPart], key: Int) -> Built {
        if let hit = cache[key] { return hit }
        let out = NSMutableAttributedString()
        var codes: [String] = []
        for (i, part) in parts.enumerated() {
            let last = i == parts.count - 1
            // Words right under a code panel or a table keep a gap from it.
            let gap: CGFloat = i > 0 && (parts[i - 1].isCode || parts[i - 1].table != nil) ? 8 : 0
            switch part {
            case .prose(let a): out.append(paragraph(inline(a), last: last, before: gap))
            case .heading(let level, let a):
                let head = inline(a, font: Theme.sansFont(level <= 2 ? 15 : 14, .semibold))
                out.append(paragraph(head, last: last, before: max(gap, 4)))
            case .item(let marker, let a, let depth):
                let line = NSMutableAttributedString(
                    string: marker + "\t",
                    attributes: [.font: Theme.sansFont(13), .foregroundColor: NSColor(marker == "☑" ? Theme.heatBright : Theme.textMuted)])
                line.append(inline(a))
                let style = NSMutableParagraphStyle()
                let indent = CGFloat(depth) * 18
                style.tabStops = [NSTextTab(textAlignment: .left, location: indent + 20)]
                style.firstLineHeadIndent = indent
                style.headIndent = indent + 20
                let item = NSMutableAttributedString(attributedString: paragraph(line, last: last, style: style, before: gap, after: 3))
                item.addAttribute(itemKey, value: true, range: NSRange(location: 0, length: item.length))
                out.append(item)
            case .code(let c, let lang):
                if i > 0 { out.append(spacer) }
                out.append(code(c, language: lang, index: codes.count, last: last))
                codes.append(c)
            case .table(let t):
                if i > 0 { out.append(spacer) }
                out.append(table(t, id: i, last: last))
            }
        }
        let built = Built(text: out, codes: codes)
        if cache.count > 500 { cache.removeAll() }
        cache[key] = built
        return built
    }

    static var base: [NSAttributedString.Key: Any] { [.font: Theme.sansFont(13), .foregroundColor: NSColor(Theme.text)] }

    private static func paragraph(
        _ s: NSAttributedString, last: Bool, style: NSMutableParagraphStyle = NSMutableParagraphStyle(), before: CGFloat = 0, after: CGFloat = 6
    ) -> NSAttributedString {
        let p = NSMutableAttributedString(attributedString: s)
        if !last { p.append(NSAttributedString(string: "\n", attributes: base)) }
        style.lineSpacing = 3
        style.paragraphSpacing = after
        style.paragraphSpacingBefore = before
        p.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: p.length))
        return p
    }

    /// Inline Markdown (bold, italic, struck, `code`, links) as AppKit attributes.
    static func inline(_ a: AttributedString, font: NSFont = Theme.sansFont(13)) -> NSAttributedString {
        let out = NSMutableAttributedString()
        for run in a.runs {
            var attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor(Theme.text)]
            let intent = run.inlinePresentationIntent ?? []
            if intent.contains(.stronglyEmphasized) { attrs[.font] = Theme.sansFont(font.pointSize, .bold) }
            if intent.contains(.emphasized) {
                attrs[.font] = NSFontManager.shared.convert(attrs[.font] as? NSFont ?? font, toHaveTrait: .italicFontMask)
            }
            if intent.contains(.strikethrough) { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if intent.contains(.code) {
                attrs[.font] = Theme.monoFont(12)
                attrs[.foregroundColor] = NSColor(Theme.silver)
                attrs[.backgroundColor] = NSColor(Theme.wash2)
            }
            if let link = run.link { attrs[.link] = link }
            out.append(NSAttributedString(string: String(a[run.range].characters), attributes: attrs))
        }
        return out
    }

    private static func code(_ c: String, language: String?, index: Int, last: Bool) -> NSAttributedString {
        let block = NSTextBlock()
        block.setValue(100, type: .percentageValueType, for: .width)
        block.backgroundColor = NSColor(Theme.bg)
        block.setBorderColor(NSColor(Theme.border))
        block.setWidth(1, type: .absoluteValueType, for: .border)
        block.setWidth(10, type: .absoluteValueType, for: .padding)
        // Room on the right for the block's copy button.
        block.setWidth(34, type: .absoluteValueType, for: .padding, edge: .maxX)
        let style = NSMutableParagraphStyle()
        style.textBlocks = [block]
        style.lineBreakMode = .byCharWrapping
        let s = NSMutableAttributedString()
        for t in Syntax.tokens(c, language: language) {
            s.append(NSAttributedString(string: t.text, attributes: [.font: Theme.monoFont(11), .foregroundColor: NSColor(Syntax.color(t.kind))]))
        }
        s.append(NSAttributedString(string: "\n", attributes: [.font: Theme.monoFont(11)]))
        s.addAttributes([.paragraphStyle: style, codeKey: index], range: NSRange(location: 0, length: s.length))
        if last { s.deleteCharacters(in: NSRange(location: s.length - 1, length: 1)) }
        return s
    }

    private static func table(_ t: MarkdownTable, id: Int, last: Bool) -> NSAttributedString {
        let table = NSTextTable()
        table.numberOfColumns = t.header.count
        table.collapsesBorders = true
        table.hidesEmptyCells = false
        let s = NSMutableAttributedString()
        let rows = [t.header] + t.rows
        for (r, row) in rows.enumerated() {
            for (c, cell) in row.enumerated() {
                let block = NSTextTableBlock(table: table, startingRow: r, rowSpan: 1, startingColumn: c, columnSpan: 1)
                block.setBorderColor(NSColor(Theme.border))
                block.setWidth(1, type: .absoluteValueType, for: .border)
                block.setWidth(6, type: .absoluteValueType, for: .padding)
                block.setWidth(12, type: .absoluteValueType, for: .padding, edge: .minX)
                block.setWidth(12, type: .absoluteValueType, for: .padding, edge: .maxX)
                block.backgroundColor = r == 0 ? NSColor(Theme.wash2) : r % 2 == 0 ? NSColor(Theme.wash1) : nil
                let style = NSMutableParagraphStyle()
                style.textBlocks = [block]
                let align = c < t.align.count ? t.align[c] : .leading
                style.alignment = align == .center ? .center : align == .trailing ? .right : .left
                let words = NSMutableAttributedString(
                    attributedString: inline(cell, font: r == 0 ? Theme.sansFont(12, .semibold) : Theme.sansFont(13)))
                if r == 0 { words.addAttribute(.foregroundColor, value: NSColor(Theme.textSec), range: NSRange(location: 0, length: words.length)) }
                words.append(NSAttributedString(string: "\n", attributes: base))
                words.addAttributes([.paragraphStyle: style, cellKey: "\(id),\(r),\(c)"], range: NSRange(location: 0, length: words.length))
                s.append(words)
            }
        }
        if last { s.deleteCharacters(in: NSRange(location: s.length - 1, length: 1)) }
        return s
    }

    /// Readable text for a range of a built message: a blank line between blocks, list items one per line, code as
    /// written, table rows as `a | b`.
    static func plain(_ text: NSAttributedString, range: NSRange) -> String {
        let ns = text.string as NSString
        var lines: [String] = []
        var row: (key: String, cells: [String])?
        var lastGroup: String?
        func flushRow() {
            if let r = row { lines.append(r.cells.joined(separator: " | ")) }
            row = nil
        }
        var at = range.location
        let end = min(NSMaxRange(range), ns.length)
        while at < end {
            let para = ns.paragraphRange(for: NSRange(location: at, length: 0))
            if text.attribute(spacerKey, at: para.location, effectiveRange: nil) != nil {
                at = max(NSMaxRange(para), at + 1)
                continue
            }
            var words = ns.substring(with: NSIntersectionRange(para, range))
            while words.hasSuffix("\n") { words.removeLast() }
            let cell = text.attribute(cellKey, at: para.location, effectiveRange: nil) as? String
            let group: String
            if let cell {
                group = "t" + (cell.split(separator: ",").first.map(String.init) ?? "")
            } else if let code = text.attribute(codeKey, at: para.location, effectiveRange: nil) as? Int {
                group = "c\(code)"
            } else if text.attribute(itemKey, at: para.location, effectiveRange: nil) != nil {
                group = "items"
            } else {
                group = "p\(para.location)"
            }
            if let lastGroup, lastGroup != group {
                flushRow()
                lines.append("")
            }
            lastGroup = group
            if let cell {
                let key = cell.split(separator: ",").prefix(2).joined(separator: ",")
                if row?.key == key {
                    row?.cells.append(words)
                } else {
                    flushRow()
                    row = (key, [words])
                }
            } else {
                lines.append(words)
            }
            at = max(NSMaxRange(para), at + 1)
        }
        flushRow()
        return lines.joined(separator: "\n")
    }
}
