import Foundation

/// What's picked in a terminal with the mouse: from where the press was to where the mouse is, in the screen's
/// whole text (history lines first, then the screen's own rows). A block pick (⌥-drag) takes the same columns on
/// every row. Pure, so the selftest can read it.
struct TerminalSelection: Equatable {
    struct Spot: Equatable, Comparable {
        var row: Int
        var col: Int
        static func < (a: Spot, b: Spot) -> Bool { a.row != b.row ? a.row < b.row : a.col < b.col }
    }

    var anchor: Spot
    var head: Spot
    var block = false

    private var first: Spot { min(anchor, head) }
    private var last: Spot { max(anchor, head) }

    func contains(row: Int, col: Int) -> Bool {
        if block {
            return (min(anchor.row, head.row)...max(anchor.row, head.row)).contains(row)
                && (min(anchor.col, head.col)...max(anchor.col, head.col)).contains(col)
        }
        let s = Spot(row: row, col: col)
        return first <= s && s <= last
    }

    /// The picked text: one line per row, spaces at a row's end dropped.
    func text(_ lines: [[Character]]) -> String {
        guard !lines.isEmpty else { return "" }
        let top = max(min(anchor.row, head.row), 0)
        let bottom = min(max(anchor.row, head.row), lines.count - 1)
        guard top <= bottom else { return "" }
        var out: [String] = []
        for r in top...bottom {
            let line = lines[r]
            let from: Int
            let to: Int
            if block {
                from = min(anchor.col, head.col)
                to = max(anchor.col, head.col)
            } else {
                from = r == first.row ? first.col : 0
                to = r == last.row ? last.col : line.count - 1
            }
            let picked = from < line.count && from <= to ? String(line[from...min(to, line.count - 1)]) : ""
            out.append(String(picked.reversed().drop { $0 == " " }.reversed()))
        }
        return out.joined(separator: "\n")
    }

    /// A double-click: the word under the spot (letters, digits and the marks paths and flags are made of).
    static func word(at s: Spot, in line: [Character]) -> TerminalSelection? {
        guard line.indices.contains(s.col), isWordy(line[s.col]) else { return nil }
        var a = s.col
        var b = s.col
        while a > 0, isWordy(line[a - 1]) { a -= 1 }
        while b < line.count - 1, isWordy(line[b + 1]) { b += 1 }
        return TerminalSelection(anchor: Spot(row: s.row, col: a), head: Spot(row: s.row, col: b))
    }

    /// A triple-click: the whole row.
    static func line(_ row: Int, in line: [Character]) -> TerminalSelection {
        TerminalSelection(anchor: Spot(row: row, col: 0), head: Spot(row: row, col: max(line.count - 1, 0)))
    }

    static func isWordy(_ c: Character) -> Bool {
        !c.isWhitespace && !"()[]{}<>'\"`,;|".contains(c)
    }
}
