import SwiftUI

/// The agent's words, and long messages such as a card's prompt: Markdown drawn as text (headings, lists, bold, inline
/// code) with code blocks in mono on their own panel. Parsed once per text and kept, so scrolling back through a long
/// chat never parses again.
struct MessageText: View {
    let text: String
    var writing = false
    /// Takes the whole width (the agent's words); a message bubble sizes to its text instead.
    var fill = true

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(MarkdownCache.parts(text).enumerated()), id: \.offset) { _, part in
                MarkdownBlock(part: part)
            }
            if writing { Rectangle().fill(Theme.heat).frame(width: 7, height: 14) }
        }
        .frame(maxWidth: fill ? .infinity : nil, alignment: .leading)
    }
}

struct MarkdownBlock: View {
    let part: MarkdownPart

    var body: some View {
        switch part {
        case .prose(let a): Text(a).font(Theme.sans(13)).foregroundStyle(Theme.text).lineSpacing(3).textSelection(.enabled)
        case .heading(let level, let a):
            Text(a).font(Theme.sans(level <= 2 ? 15 : 14, .semibold)).foregroundStyle(Theme.text).textSelection(.enabled).padding(.top, 4)
        case .item(let marker, let a, let depth):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(marker).font(Theme.sans(13)).foregroundStyle(Theme.textMuted).frame(minWidth: 14, alignment: .trailing)
                Text(a).font(Theme.sans(13)).foregroundStyle(Theme.text).lineSpacing(3).textSelection(.enabled)
            }
            .padding(.leading, CGFloat(depth) * 18)
        case .code(let c, _):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(c).font(Theme.mono(11)).foregroundStyle(Theme.silver).textSelection(.enabled).padding(10)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(Theme.bg))
            .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.border))
        }
    }
}

enum MarkdownPart {
    case prose(AttributedString)
    /// A `#` to `######` heading: its level and words.
    case heading(Int, AttributedString)
    /// A list item: its marker ("•" or "2."), words, and how deep it's nested.
    case item(String, AttributedString, Int)
    /// A fenced code block and the language its fence names, if any.
    case code(String, String?)
}

@MainActor
enum MarkdownCache {
    private static var cache: [Int: [MarkdownPart]] = [:]

    static func parts(_ text: String) -> [MarkdownPart] {
        let key = text.hashValue
        if let hit = cache[key] { return hit }
        var out: [MarkdownPart] = []
        for (i, chunk) in text.components(separatedBy: "```").enumerated() {
            if i % 2 == 1 {
                let body = chunk.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
                let lang = body.first.map { $0.trimmingCharacters(in: .whitespaces) }.flatMap { $0.isEmpty ? nil : $0 }
                out.append(.code(body.count > 1 ? String(body[1]).trimmingCharacters(in: .newlines) : chunk, body.count > 1 ? lang : nil))
            } else {
                out += blocks(chunk)
            }
        }
        if cache.count > 4000 { cache.removeAll() }
        cache[key] = out
        return out
    }

    /// Prose between code fences, block by block: headings, list items (with lines that carry on under them) and
    /// paragraphs; everything inside them is inline Markdown.
    static func blocks(_ prose: String) -> [MarkdownPart] {
        var out: [MarkdownPart] = []
        var paragraph: [String] = []
        var item: (marker: String, lines: [String], depth: Int)?
        func flush() {
            if !paragraph.isEmpty { out.append(.prose(inline(paragraph.joined(separator: "\n")))) }
            paragraph = []
            if let i = item { out.append(.item(i.marker, inline(i.lines.joined(separator: " ")), i.depth)) }
            item = nil
        }
        for raw in prose.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            let indent = raw.prefix { $0 == " " || $0 == "\t" }.count
            if line.isEmpty {
                flush()
            } else if let h = heading(line) {
                flush()
                out.append(.heading(h.level, inline(h.words)))
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

    private static func heading(_ line: String) -> (level: Int, words: String)? {
        let hashes = line.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes), line.dropFirst(hashes).first == " " else { return nil }
        return (hashes, String(line.dropFirst(hashes + 1)))
    }

    private static func listItem(_ line: String) -> (marker: String, words: String)? {
        if let first = line.first, "-*+".contains(first), line.dropFirst().first == " " {
            return ("•", String(line.dropFirst(2)))
        }
        let digits = line.prefix { $0.isNumber }
        guard !digits.isEmpty, digits.count < 4 else { return nil }
        let rest = line.dropFirst(digits.count)
        guard let dot = rest.first, dot == "." || dot == ")", rest.dropFirst().first == " " else { return nil }
        return ("\(digits).", String(rest.dropFirst(2)))
    }

    /// Inline Markdown, with `code` drawn in mono on a light wash so it stands apart from the words.
    static func inline(_ s: String) -> AttributedString {
        var a = (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
        for run in a.runs where run.inlinePresentationIntent?.contains(.code) == true {
            a[run.range].font = Theme.mono(12)
            a[run.range].foregroundColor = Theme.silver
            a[run.range].backgroundColor = Theme.wash2
        }
        return a
    }
}
