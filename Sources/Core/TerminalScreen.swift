import Foundation

/// What a terminal shows: a grid of cells fed by a shell's output, read the way xterm does (the subset a login shell,
/// git, test runners and full-screen programs like less or vim use): printing with wrap, CR/LF/BS/TAB, cursor moves,
/// erasing, insert and delete, scroll regions, colours (16, 256 and RGB), the alternate screen, and the two reports a
/// shell asks for. Lines that scroll off the top go into `scrollback`. Plain logic: the view draws it
/// (UI/TerminalPanel.swift), EngineHost/TerminalProcess.swift feeds it. Built for Omar's session terminal (Nov 12).
final class TerminalScreen {
    struct Attr: Equatable {
        /// Palette index 0-255, or `TerminalScreen.rgb(_:_:_:)`; nil = the default colour.
        var fg: Int?
        var bg: Int?
        var bold = false
        var underline = false
        var inverse = false
    }

    struct Cell: Equatable {
        var ch: Character = " "
        var attr = Attr()
        var fg: Int? { attr.fg }
        var bg: Int? { attr.bg }
    }

    static func rgb(_ r: Int, _ g: Int, _ b: Int) -> Int { 0x100_0000 | (r << 16) | (g << 8) | b }

    private(set) var cols: Int
    private(set) var rows: Int
    private(set) var grid: [[Cell]]
    private(set) var scrollback: [[Cell]] = []
    var maxScrollback = 5000
    private(set) var row = 0
    private(set) var col = 0
    private(set) var cursorVisible = true
    /// Arrow keys send ESC O x instead of ESC [ x (DECCKM).
    private(set) var appCursor = false
    private(set) var bracketedPaste = false
    private(set) var title: String?
    /// Answers the shell asked for (cursor position, device attributes), to write back to it.
    var reply: (([UInt8]) -> Void)?

    private var attr = Attr()
    private var wrapPending = false
    private var top = 0
    private var bottom: Int
    private var saved: (row: Int, col: Int, attr: Attr) = (0, 0, Attr())
    private var mainScreen: [[Cell]]?
    private var state = Parse.ground
    private var seq: [UInt8] = []
    private var utf8: [UInt8] = []
    private var utf8Need = 0

    private enum Parse { case ground, esc, csi, osc, oscEsc, charset }

    init(cols: Int, rows: Int) {
        self.cols = max(cols, 2)
        self.rows = max(rows, 1)
        bottom = self.rows - 1
        grid = Array(repeating: Array(repeating: Cell(), count: self.cols), count: self.rows)
    }

    var isAlternate: Bool { mainScreen != nil }
    var cursor: (row: Int, col: Int) { (row, min(col, cols - 1)) }

    func cell(row r: Int, col c: Int) -> Cell { grid.indices.contains(r) && c >= 0 && c < cols ? grid[r][c] : Cell() }

    static func text(_ cells: [Cell]) -> String {
        var s = String(cells.map(\.ch))
        while s.last == " " { s.removeLast() }
        return s
    }

    func line(_ i: Int) -> String { grid.indices.contains(i) ? Self.text(grid[i]) : "" }
    var history: [String] { scrollback.map(Self.text) }
    /// Everything: the history, then the screen.
    var text: String { (history + grid.map(Self.text)).joined(separator: "\n") }

    // MARK: feeding

    func feed(_ bytes: [UInt8]) {
        for b in bytes { step(b) }
    }

    private func step(_ b: UInt8) {
        switch state {
        case .ground: ground(b)
        case .esc: escape(b)
        case .charset: state = .ground
        case .csi:
            if (0x40...0x7E).contains(b) {
                csi(final: b, String(decoding: seq, as: UTF8.self))
                state = .ground
            } else if b == 0x1B {
                state = .esc
            } else if seq.count < 64 {
                seq.append(b)
            }
        case .osc:
            if b == 0x07 { osc() } else if b == 0x1B { state = .oscEsc } else if seq.count < 512 { seq.append(b) }
        case .oscEsc:
            osc()
            if b != 0x5C { step(b) }
        }
    }

    private func ground(_ b: UInt8) {
        if utf8Need > 0 {
            guard b & 0xC0 == 0x80 else {
                utf8Need = 0
                utf8 = []
                return ground(b)
            }
            utf8.append(b)
            utf8Need -= 1
            if utf8Need == 0 {
                if let ch = String(bytes: utf8, encoding: .utf8)?.first { put(ch) }
                utf8 = []
            }
            return
        }
        switch b {
        case 0x1B: state = .esc
        case 0x07, 0x00: break
        case 0x08:
            col = max(0, min(col, cols - 1) - 1)
            wrapPending = false
        case 0x09:
            col = min(cols - 1, (col / 8 + 1) * 8)
            wrapPending = false
        case 0x0A, 0x0B, 0x0C: lineFeed()
        case 0x0D:
            col = 0
            wrapPending = false
        case 0x20...0x7E: put(Character(UnicodeScalar(b)))
        case 0xC0...0xDF: (utf8, utf8Need) = ([b], 1)
        case 0xE0...0xEF: (utf8, utf8Need) = ([b], 2)
        case 0xF0...0xF7: (utf8, utf8Need) = ([b], 3)
        default: break
        }
    }

    private func put(_ ch: Character) {
        if wrapPending {
            col = 0
            lineFeed()
            wrapPending = false
        }
        grid[row][col] = Cell(ch: ch, attr: attr)
        if col == cols - 1 { wrapPending = true } else { col += 1 }
    }

    private func lineFeed() {
        wrapPending = false
        if row == bottom { scrollUp(1) } else if row < rows - 1 { row += 1 }
    }

    private var blankLine: [Cell] { Array(repeating: Cell(attr: Attr(bg: attr.bg)), count: cols) }

    private func scrollUp(_ n: Int) {
        for _ in 0..<min(n, bottom - top + 1) {
            let gone = grid.remove(at: top)
            if top == 0, mainScreen == nil {
                scrollback.append(gone)
                if scrollback.count > maxScrollback { scrollback.removeFirst(scrollback.count - maxScrollback) }
            }
            grid.insert(blankLine, at: bottom)
        }
    }

    private func scrollDown(_ n: Int) {
        for _ in 0..<min(n, bottom - top + 1) {
            grid.remove(at: bottom)
            grid.insert(blankLine, at: top)
        }
    }

    private func escape(_ b: UInt8) {
        state = .ground
        switch b {
        case 0x5B:  // [
            seq = []
            state = .csi
        case 0x5D:  // ]
            seq = []
            state = .osc
        case 0x28, 0x29, 0x2A, 0x2B: state = .charset
        case 0x37: saved = (row, col, attr)  // 7
        case 0x38: (row, col, attr) = (min(saved.row, rows - 1), min(saved.col, cols - 1), saved.attr)  // 8
        case 0x44: lineFeed()  // D
        case 0x45:  // E
            col = 0
            lineFeed()
        case 0x4D:  // M
            if row == top { scrollDown(1) } else { row = max(0, row - 1) }
        case 0x63: reset()  // c
        default: break
        }
    }

    private func osc() {
        state = .ground
        let s = String(decoding: seq, as: UTF8.self)
        if s.hasPrefix("0;") || s.hasPrefix("2;") { title = String(s.dropFirst(2)) }
    }

    private func reset() {
        grid = Array(repeating: Array(repeating: Cell(), count: cols), count: rows)
        (row, col, attr, wrapPending, top, bottom, mainScreen) = (0, 0, Attr(), false, 0, rows - 1, nil)
    }

    // MARK: control sequences

    private func csi(final: UInt8, _ raw: String) {
        let priv = raw.first.map { "?>=<".contains($0) } ?? false
        let body = priv ? String(raw.dropFirst()) : raw
        let nums = body.split(separator: ";", omittingEmptySubsequences: false).map { Int($0.filter(\.isNumber)) }
        // Counts and 1-based positions: missing or 0 means 1.
        func n(_ i: Int) -> Int { max(nums.indices.contains(i) ? (nums[i] ?? 0) : 0, 1) }
        let c = Character(UnicodeScalar(final))
        if c != "m" { wrapPending = false }
        switch c {
        case "A": row = max(row < top ? 0 : top, row - n(0))
        case "B", "e": row = min(row > bottom ? rows - 1 : bottom, row + n(0))
        case "C", "a": col = min(cols - 1, col + n(0))
        case "D": col = max(0, min(col, cols - 1) - n(0))
        case "E": (row, col) = (min(rows - 1, row + n(0)), 0)
        case "F": (row, col) = (max(0, row - n(0)), 0)
        case "G", "`": col = min(cols - 1, n(0) - 1)
        case "d": row = min(rows - 1, n(0) - 1)
        case "H", "f": (row, col) = (min(rows - 1, n(0) - 1), min(cols - 1, n(1) - 1))
        case "J": eraseDisplay(nums.first.flatMap { $0 } ?? 0)
        case "K": eraseLine(nums.first.flatMap { $0 } ?? 0)
        case "L": if (top...bottom).contains(row) { insertLines(n(0)) }
        case "M": if (top...bottom).contains(row) { deleteLines(n(0)) }
        case "@": shiftChars(insert: n(0))
        case "P": shiftChars(delete: n(0))
        case "X": for i in col..<min(cols, col + n(0)) { grid[row][i] = Cell(attr: Attr(bg: attr.bg)) }
        case "S": scrollUp(n(0))
        case "T": scrollDown(n(0))
        case "m": sgr(nums.map { $0 ?? 0 })
        case "r":
            let t = max(1, nums.first.flatMap { $0 } ?? 1)
            let b = min(rows, (nums.count > 1 ? nums[1] : nil) ?? rows)
            if t < b { (top, bottom, row, col) = (t - 1, b - 1, 0, 0) }
        case "s": saved = (row, col, attr)
        case "u": (row, col, attr) = (min(saved.row, rows - 1), min(saved.col, cols - 1), saved.attr)
        case "h", "l": if priv { mode(nums.compactMap { $0 }, on: c == "h") }
        case "n": if nums.first == 6 { reply?(Array("\u{1B}[\(row + 1);\(min(col, cols - 1) + 1)R".utf8)) }
        case "c": if !raw.hasPrefix(">") { reply?(Array("\u{1B}[?1;2c".utf8)) }
        default: break
        }
    }

    private func mode(_ ms: [Int], on: Bool) {
        for m in ms {
            switch m {
            case 1: appCursor = on
            case 25: cursorVisible = on
            case 2004: bracketedPaste = on
            case 47, 1047, 1049:
                if on, mainScreen == nil {
                    if m == 1049 { saved = (row, col, attr) }
                    mainScreen = grid
                    grid = Array(repeating: Array(repeating: Cell(), count: cols), count: rows)
                } else if !on, let main = mainScreen {
                    grid = main
                    mainScreen = nil
                    if m == 1049 { (row, col, attr) = (min(saved.row, rows - 1), min(saved.col, cols - 1), saved.attr) }
                }
            default: break
            }
        }
    }

    private func eraseDisplay(_ how: Int) {
        let blank = Cell(attr: Attr(bg: attr.bg))
        switch how {
        case 0:
            eraseLine(0)
            for r in (row + 1)..<rows { grid[r] = Array(repeating: blank, count: cols) }
        case 1:
            eraseLine(1)
            for r in 0..<row { grid[r] = Array(repeating: blank, count: cols) }
        default:
            grid = Array(repeating: Array(repeating: blank, count: cols), count: rows)
            if how == 3 { scrollback = [] }
        }
    }

    private func eraseLine(_ how: Int) {
        let blank = Cell(attr: Attr(bg: attr.bg))
        let c = min(col, cols - 1)
        let range = how == 0 ? c..<cols : how == 1 ? 0..<(c + 1) : 0..<cols
        for i in range { grid[row][i] = blank }
    }

    private func insertLines(_ n: Int) {
        for _ in 0..<min(n, bottom - row + 1) {
            grid.remove(at: bottom)
            grid.insert(blankLine, at: row)
        }
    }

    private func deleteLines(_ n: Int) {
        for _ in 0..<min(n, bottom - row + 1) {
            grid.remove(at: row)
            grid.insert(blankLine, at: bottom)
        }
    }

    private func shiftChars(insert: Int = 0, delete: Int = 0) {
        let c = min(col, cols - 1)
        var line = grid[row]
        if insert > 0 {
            line.insert(contentsOf: Array(repeating: Cell(), count: min(insert, cols - c)), at: c)
            line = Array(line.prefix(cols))
        } else {
            line.removeSubrange(c..<min(cols, c + delete))
            line += Array(repeating: Cell(attr: Attr(bg: attr.bg)), count: cols - line.count)
        }
        grid[row] = line
    }

    private func sgr(_ p: [Int]) {
        var i = 0
        let ps = p.isEmpty ? [0] : p
        while i < ps.count {
            let v = ps[i]
            switch v {
            case 0: attr = Attr()
            case 1: attr.bold = true
            case 22: attr.bold = false
            case 4: attr.underline = true
            case 24: attr.underline = false
            case 7: attr.inverse = true
            case 27: attr.inverse = false
            case 30...37: attr.fg = v - 30
            case 39: attr.fg = nil
            case 40...47: attr.bg = v - 40
            case 49: attr.bg = nil
            case 90...97: attr.fg = v - 90 + 8
            case 100...107: attr.bg = v - 100 + 8
            case 38, 48:
                var color: Int?
                if i + 2 < ps.count, ps[i + 1] == 5 {
                    color = ps[i + 2]
                    i += 2
                } else if i + 4 < ps.count, ps[i + 1] == 2 {
                    color = Self.rgb(ps[i + 2], ps[i + 3], ps[i + 4])
                    i += 4
                }
                if v == 38 { attr.fg = color } else { attr.bg = color }
            default: break
            }
            i += 1
        }
    }

    // MARK: size

    /// A new size: lines that no longer fit above the cursor go into the history; columns are cut or padded.
    func resize(cols c: Int, rows r: Int) {
        let c = max(c, 2)
        let r = max(r, 1)
        guard c != cols || r != rows else { return }
        func fit(_ line: [Cell]) -> [Cell] { line.count >= c ? Array(line.prefix(c)) : line + Array(repeating: Cell(), count: c - line.count) }
        var g = grid.map(fit)
        scrollback = scrollback.map(fit)
        var cursorRow = row
        while g.count > r {
            if cursorRow < g.count - 1, Self.text(g[g.count - 1]).isEmpty {
                g.removeLast()
            } else {
                let first = g.removeFirst()
                if mainScreen == nil { scrollback.append(first) }
                cursorRow -= 1
            }
        }
        while g.count < r { g.append(Array(repeating: Cell(), count: c)) }
        mainScreen = mainScreen.map { m in
            Array((m.map(fit) + Array(repeating: Array(repeating: Cell(), count: c), count: max(0, r - m.count))).suffix(r))
        }
        (grid, cols, rows) = (g, c, r)
        (row, col, top, bottom, wrapPending) = (max(0, min(cursorRow, r - 1)), min(col, c - 1), 0, r - 1, false)
    }
}
