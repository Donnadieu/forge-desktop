import SwiftUI

/// The agent's words, and long messages such as a card's prompt: Markdown drawn as one selectable text (headings,
/// lists, task lists, bold, strikethrough, inline code, GFM tables, code blocks in mono on their own panel; RichText). Paths that name
/// a file in the session's worktree (`\.worktree`) are links. Parsed once per text and kept, so scrolling back through
/// a long chat never parses again.
struct MessageText: View {
    let text: String
    var writing = false
    /// Takes the whole width (the agent's words); a message bubble sizes to its text instead.
    var fill = true
    @Environment(\.worktree) private var worktree

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // One text for the whole message, so a drag selects across its blocks (RichText, ChatText.swift).
            RichMessage(text: text, parts: MarkdownCache.parts(text, folder: worktree), key: MarkdownCache.key(text, folder: worktree), fill: fill)
            if writing { Rectangle().fill(Theme.heat).frame(width: 7, height: 14) }
        }
        .frame(maxWidth: fill ? .infinity : nil, alignment: .leading)
        .tint(Theme.heatBright)
    }
}

/// A GFM table: its header, each column's alignment, and its rows (each as wide as the header).
struct MarkdownTable {
    enum Align: Equatable { case leading, center, trailing }
    var header: [AttributedString]
    var align: [Align]
    var rows: [[AttributedString]]
}

enum MarkdownPart {
    case prose(AttributedString)
    /// A `#` to `######` heading: its level and words.
    case heading(Int, AttributedString)
    /// A list item: its marker ("•", "2.", or "☐"/"☑" for a task), words, and how deep it's nested.
    case item(String, AttributedString, Int)
    /// A fenced code block and the language its fence names, if any.
    case code(String, String?)
    /// A GFM table.
    case table(MarkdownTable)

    var table: MarkdownTable? {
        if case .table(let t) = self { return t }
        return nil
    }

    var isCode: Bool {
        if case .code = self { return true }
        return false
    }

    /// Every run of words in the block (a table's cells too), for reading it back or finding its links.
    var texts: [AttributedString] {
        switch self {
        case .prose(let a), .heading(_, let a), .item(_, let a, _): return [a]
        case .code: return []
        case .table(let t): return t.header + t.rows.flatMap { $0 }
        }
    }
}

/// The session's worktree: paths in the chat resolve against it and become links. Nil (a card's detail, previews)
/// means no links.
private struct WorktreeKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

extension EnvironmentValues {
    var worktree: String? {
        get { self[WorktreeKey.self] }
        set { self[WorktreeKey.self] = newValue }
    }
}

@MainActor
enum MarkdownCache {
    private static var cache: [Int: [MarkdownPart]] = [:]

    static func parts(_ text: String) -> [MarkdownPart] { parts(text, folder: nil) }

    /// The text's blocks; with a worktree, paths to its files are links.
    static func key(_ text: String, folder: String?) -> Int {
        var h = Hasher()
        h.combine(text)
        h.combine(folder)
        return h.finalize()
    }

    static func parts(_ text: String, folder: String?) -> [MarkdownPart] {
        let key = key(text, folder: folder)
        if let hit = cache[key] { return hit }
        var out: [MarkdownPart] = []
        for (i, chunk) in text.components(separatedBy: "```").enumerated() {
            if i % 2 == 1 {
                let body = chunk.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
                let lang = body.first.map { $0.trimmingCharacters(in: .whitespaces) }.flatMap { $0.isEmpty ? nil : $0 }
                out.append(.code(body.count > 1 ? String(body[1]).trimmingCharacters(in: .newlines) : chunk, body.count > 1 ? lang : nil))
            } else {
                out += blocks(chunk, folder: folder)
            }
        }
        if cache.count > 4000 { cache.removeAll() }
        cache[key] = out
        return out
    }

    /// Prose between code fences, block by block: headings, list items (with lines that carry on under them), tables
    /// and paragraphs; everything inside them is inline Markdown.
    static func blocks(_ prose: String, folder: String? = nil) -> [MarkdownPart] {
        var out: [MarkdownPart] = []
        var paragraph: [String] = []
        var item: (marker: String, lines: [String], depth: Int)?
        func flush() {
            if !paragraph.isEmpty { out.append(.prose(inline(paragraph.joined(separator: "\n"), folder: folder))) }
            paragraph = []
            if let i = item { out.append(.item(i.marker, inline(i.lines.joined(separator: " "), folder: folder), i.depth)) }
            item = nil
        }
        let lines = prose.components(separatedBy: "\n")
        var n = 0
        while n < lines.count {
            let raw = lines[n]
            n += 1
            let line = raw.trimmingCharacters(in: .whitespaces)
            let indent = raw.prefix { $0 == " " || $0 == "\t" }.count
            if line.isEmpty {
                flush()
            } else if n < lines.count, let t = tableStart(line, lines[n]) {
                // A header row with a separator row under it: the table runs until a blank line or a line with no pipe.
                flush()
                n += 1
                var rows: [[String]] = []
                while n < lines.count {
                    let next = lines[n].trimmingCharacters(in: .whitespaces)
                    guard !next.isEmpty, next.contains("|") else { break }
                    let cells = cells(next)
                    rows.append((0..<t.header.count).map { $0 < cells.count ? cells[$0] : "" })
                    n += 1
                }
                let table = MarkdownTable(
                    header: t.header.map { inline($0, folder: folder) }, align: t.align, rows: rows.map { $0.map { inline($0, folder: folder) } })
                out.append(.table(table))
            } else if let h = heading(line) {
                flush()
                out.append(.heading(h.level, inline(h.words, folder: folder)))
            } else if let li = listItem(line) {
                flush()
                item = (li.marker, [li.words], min(indent / 2, 4))
            } else if item != nil, indent > 0 {
                item?.lines.append(line)
            } else if line.allSatisfy({ $0 == "-" || $0 == "*" || $0 == "_" }), line.count >= 3 {
                flush()
            } else {
                if item != nil { flush() }
                paragraph.append(line.hasPrefix("> ") ? String(line.dropFirst(2)) : line)
            }
        }
        flush()
        return out
    }

    /// A table starts where a row of cells has a separator row (`|---|:-:|`) with as many cells right under it.
    private static func tableStart(_ line: String, _ next: String) -> (header: [String], align: [MarkdownTable.Align])? {
        guard line.contains("|") else { return nil }
        let sep = next.trimmingCharacters(in: .whitespaces)
        guard sep.contains("|"), sep.contains("-") else { return nil }
        let marks = cells(sep)
        let ok =
            !marks.isEmpty
            && marks.allSatisfy { m in
                let core = m.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
                return !core.isEmpty && core.allSatisfy { $0 == "-" } && m.count - core.count <= 2
            }
        let header = cells(line)
        guard ok, header.count == marks.count else { return nil }
        let align = marks.map { m -> MarkdownTable.Align in
            switch (m.hasPrefix(":"), m.hasSuffix(":")) {
            case (true, true): return .center
            case (false, true): return .trailing
            default: return .leading
            }
        }
        return (header, align)
    }

    /// A table row's cells: split on pipes that aren't escaped or inside `code`, outer pipes dropped.
    static func cells(_ row: String) -> [String] {
        var s = Substring(row.trimmingCharacters(in: .whitespaces))
        if s.hasPrefix("|") { s = s.dropFirst() }
        if s.hasSuffix("|"), !s.hasSuffix("\\|") { s = s.dropLast() }
        var out: [String] = []
        var cell = ""
        var inCode = false
        var escaped = false
        for ch in s {
            if escaped {
                cell += ch == "|" ? "|" : "\\\(ch)"
                escaped = false
            } else if ch == "\\" {
                escaped = true
            } else if ch == "|", !inCode {
                out.append(cell.trimmingCharacters(in: .whitespaces))
                cell = ""
            } else {
                if ch == "`" { inCode.toggle() }
                cell.append(ch)
            }
        }
        out.append(cell.trimmingCharacters(in: .whitespaces))
        return out
    }

    private static func heading(_ line: String) -> (level: Int, words: String)? {
        let hashes = line.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes), line.dropFirst(hashes).first == " " else { return nil }
        return (hashes, String(line.dropFirst(hashes + 1)))
    }

    private static func listItem(_ line: String) -> (marker: String, words: String)? {
        if let first = line.first, "-*+".contains(first), line.dropFirst().first == " " {
            let words = String(line.dropFirst(2))
            // A GFM task: "- [ ] to do", "- [x] done".
            for (box, marker) in [("[ ] ", "☐"), ("[x] ", "☑"), ("[X] ", "☑")] where words.hasPrefix(box) {
                return (marker, String(words.dropFirst(4)))
            }
            return ("•", words)
        }
        let digits = line.prefix { $0.isNumber }
        guard !digits.isEmpty, digits.count < 4 else { return nil }
        let rest = line.dropFirst(digits.count)
        guard let dot = rest.first, dot == "." || dot == ")", rest.dropFirst().first == " " else { return nil }
        return ("\(digits).", String(rest.dropFirst(2)))
    }

    /// Inline Markdown (~~struck~~ words come struck through), with `code` drawn in mono on a light wash so it stands
    /// apart from the words, and (with a worktree) paths to its files as links.
    static func inline(_ s: String, folder: String? = nil) -> AttributedString {
        var a = (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
        for run in a.runs where run.inlinePresentationIntent?.contains(.code) == true {
            a[run.range].font = Theme.mono(.chatCode)
            a[run.range].foregroundColor = Theme.silver
            a[run.range].backgroundColor = Theme.wash2
        }
        if let folder { FileLinks.link(&a, root: folder) }
        return a
    }
}
