import AppKit
import SwiftUI

/// The session terminal at the bottom of the chat: a drag bar to resize it, one tab per shell with its x, + for
/// another, Hide; under them the shell itself (TerminalCanvas).
struct TerminalPanel: View {
    @ObservedObject var terminals: Terminals
    let session: Sessions.Session
    let env: () -> [String: String]
    @State private var dragStart: CGFloat?

    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Theme.border).frame(height: 1)
                .overlay(
                    Rectangle().fill(Color.clear).frame(height: 9).contentShape(Rectangle()).onHover { inside in
                        if inside { NSCursor.resizeUpDown.push() } else { NSCursor.pop() }
                    }
                )
                .gesture(
                    DragGesture(minimumDistance: 1, coordinateSpace: .global)
                        .onChanged { v in
                            let start = dragStart ?? terminals.height
                            dragStart = start
                            terminals.height = min(max(start - v.translation.height, 120), 640)
                        }
                        .onEnded { _ in dragStart = nil })
            tabsRow
            if let tab = terminals.current(of: session.id) {
                TerminalCanvas(tab: tab).id(tab.id)
                    .frame(maxWidth: .infinity).frame(height: terminals.height)
            } else if let p = terminals.problem {
                Text(p).font(Theme.sans(12)).foregroundStyle(Theme.textSec).frame(maxWidth: .infinity, minHeight: 60)
            }
        }
        .background(Theme.bg)
    }

    private var tabsRow: some View {
        HStack(spacing: 6) {
            ForEach(terminals.tabs(of: session.id)) { tab in
                let on = tab.id == terminals.current(of: session.id)?.id
                HStack(spacing: 6) {
                    Image(systemName: "terminal").font(.system(size: 10))
                    Text(tab.title).font(Theme.sans(11, on ? .semibold : .regular))
                    Button {
                        terminals.close(tab, in: session.id)
                    } label: {
                        Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
                    }
                    .buttonStyle(.plain).help("Close this Terminal tab; its shell ends")
                }
                .foregroundStyle(on ? Theme.text : Theme.textSec)
                .padding(.horizontal, 10).frame(height: 26)
                .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(on ? Theme.surfaceHover : .clear))
                .contentShape(Rectangle())
                .onTapGesture { terminals.active[session.id] = tab.id }
            }
            Button {
                terminals.open(session, env: env())
            } label: {
                Image(systemName: "plus").font(.system(size: 11, weight: .medium))
            }
            .buttonStyle(ForgeButton(kind: .ghost)).help("Another Terminal tab in this session's folder")
            Spacer()
            Text(session.folder).font(Theme.mono(10)).foregroundStyle(Theme.textMuted).lineLimit(1).truncationMode(.head)
            Button("Hide") { terminals.shown.remove(session.id) }
                .buttonStyle(ForgeButton(kind: .ghost, hint: "⌃`", icon: "chevron.down"))
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Theme.surface)
    }
}

/// Hosts the drawn terminal and keeps it in step with its shell's output.
struct TerminalCanvas: NSViewRepresentable {
    @ObservedObject var tab: TerminalTab

    func makeNSView(context: Context) -> TerminalNSView {
        let v = TerminalNSView()
        v.tab = tab
        DispatchQueue.main.async { v.window?.makeFirstResponder(v) }
        return v
    }

    func updateNSView(_ v: TerminalNSView, context: Context) {
        v.tab = tab
        v.needsDisplay = true
    }
}

/// Draws a TerminalScreen cell by cell in DM Mono and sends what's typed to the shell. Scrolling up shows the history.
/// A drag picks text (⌥-drag a block, a double-click a word, a triple-click the line); ⌘C, Edit > Copy and the
/// right-click menu copy it. ⌘ keys never reach the shell; ⌃C does.
final class TerminalNSView: NSView, NSMenuItemValidation {
    weak var tab: TerminalTab?
    private var scrollBack = 0
    private(set) var selection: TerminalSelection?
    private let font = NSFont(name: "DMMono-Regular", size: 12) ?? .monospacedSystemFont(ofSize: 12, weight: .regular)
    private lazy var cellW: CGFloat = ceil(("M" as NSString).size(withAttributes: [.font: font]).width)
    private lazy var lineH: CGFloat = ceil(font.ascender - font.descender + font.leading) + 2
    private let pad: CGFloat = 8

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    /// A drag starts picking even while Forge's window is in the back.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// The screen's whole text, history first, one array of letters per row.
    @MainActor private var lines: [[Character]] {
        guard let screen = tab?.screen else { return [] }
        return (screen.scrollback + screen.grid).map { $0.map(\.ch) }
    }

    /// The row (in the whole text) and column under a point in the window.
    @MainActor private func spot(_ event: NSEvent) -> TerminalSelection.Spot? {
        guard let screen = tab?.screen else { return nil }
        let p = convert(event.locationInWindow, from: nil)
        let r = min(max(Int(floor((p.y - pad) / lineH)), 0), screen.rows - 1)
        let c = min(max(Int(floor((p.x - pad) / cellW)), 0), screen.cols - 1)
        return TerminalSelection.Spot(row: screen.scrollback.count - min(scrollBack, screen.scrollback.count) + r, col: c)
    }

    /// Picks with the mouse until it's let go (AppKit's own tracking loop, as a text view does).
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        MainActor.assumeIsolated {
            guard let s = spot(event) else { return }
            let all = lines
            let line = all.indices.contains(s.row) ? all[s.row] : []
            switch event.clickCount {
            case 2: selection = TerminalSelection.word(at: s, in: line)
            case 3...: selection = TerminalSelection.line(s.row, in: line)
            default: selection = TerminalSelection(anchor: s, head: s, block: event.modifierFlags.contains(.option))
            }
            needsDisplay = true
            var moved = false
            while let e = window?.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
                if e.type == .leftMouseUp { break }
                guard event.clickCount < 2, let h = spot(e) else { continue }
                if h != selection?.head { moved = true }
                selection?.head = h
                needsDisplay = true
                displayIfNeeded()
            }
            // A plain click picks nothing.
            if event.clickCount < 2, !moved { selection = nil }
            needsDisplay = true
        }
    }

    @objc func copy(_ sender: Any?) {
        MainActor.assumeIsolated {
            guard let text = selection?.text(lines), !text.isEmpty else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        MainActor.assumeIsolated {
            switch item.action {
            case #selector(copy(_:)): return selection.map { !$0.text(lines).isEmpty } ?? false
            case #selector(paste(_:)): return NSPasteboard.general.string(forType: .string) != nil
            default: return true
            }
        }
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Copy", action: #selector(copy(_:)), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Paste", action: #selector(paste(_:)), keyEquivalent: ""))
        return menu
    }

    override func setFrameSize(_ s: NSSize) {
        super.setFrameSize(s)
        MainActor.assumeIsolated { fit() }
    }

    @MainActor private func fit() {
        let cols = Int((bounds.width - pad * 2) / cellW)
        let rows = Int((bounds.height - pad * 2) / lineH)
        if cols > 4, rows > 1 { tab?.resize(cols: cols, rows: rows) }
    }

    override func keyDown(with e: NSEvent) {
        MainActor.assumeIsolated {
            guard let tab else { return }
            if e.modifierFlags.contains(.command) { return super.keyDown(with: e) }
            scrollBack = 0
            selection = nil
            tab.write(
                TerminalKeys.bytes(
                    chars: e.characters ?? "", key: e.keyCode, control: e.modifierFlags.contains(.control), appCursor: tab.screen.appCursor))
        }
    }

    @objc func paste(_ sender: Any?) {
        MainActor.assumeIsolated {
            guard let tab, let s = NSPasteboard.general.string(forType: .string) else { return }
            let text = s.replacingOccurrences(of: "\n", with: "\r")
            tab.write(Array((tab.screen.bracketedPaste ? "\u{1B}[200~" + text + "\u{1B}[201~" : text).utf8))
        }
    }

    override func scrollWheel(with e: NSEvent) {
        MainActor.assumeIsolated {
            guard let tab else { return }
            let step = Int((e.scrollingDeltaY / (e.hasPreciseScrollingDeltas ? lineH : 1)).rounded())
            scrollBack = min(max(scrollBack + step, 0), tab.screen.scrollback.count)
            needsDisplay = true
        }
    }

    override func draw(_ dirty: NSRect) {
        MainActor.assumeIsolated { paint() }
    }

    @MainActor private func paint() {
        TerminalColors.background.setFill()
        bounds.fill()
        guard let screen = tab?.screen else { return }
        let back = min(scrollBack, screen.scrollback.count)
        let lines = Array(screen.scrollback.suffix(back)) + Array(screen.grid.prefix(screen.rows - min(back, screen.rows)))
        let firstRow = screen.scrollback.count - back
        for (r, line) in lines.prefix(screen.rows).enumerated() {
            let y = pad + CGFloat(r) * lineH
            var c = 0
            while c < line.count {
                let a = line[c].attr
                var end = c + 1
                while end < line.count, line[end].attr == a { end += 1 }
                let (fg, bg) = TerminalColors.pair(a)
                let rect = NSRect(x: pad + CGFloat(c) * cellW, y: y, width: CGFloat(end - c) * cellW, height: lineH)
                if let bg {
                    bg.setFill()
                    rect.fill()
                }
                let text = String(line[c..<end].map(\.ch))
                if !text.trimmingCharacters(in: .whitespaces).isEmpty {
                    var attrs: [NSAttributedString.Key: Any] = [
                        .font: a.bold ? NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask) : font, .foregroundColor: fg,
                    ]
                    if a.underline { attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue }
                    // One cell per letter, whatever the font's own spacing.
                    for (i, ch) in text.enumerated() where ch != " " {
                        (String(ch) as NSString).draw(at: NSPoint(x: rect.minX + CGFloat(i) * cellW, y: y + 1), withAttributes: attrs)
                    }
                }
                c = end
            }
        }
        // The pick, tinted over the letters.
        if let sel = selection {
            TerminalColors.selection.setFill()
            for r in 0..<screen.rows {
                for c in 0..<screen.cols where sel.contains(row: firstRow + r, col: c) {
                    NSRect(x: pad + CGFloat(c) * cellW, y: pad + CGFloat(r) * lineH, width: cellW, height: lineH).fill(using: .sourceOver)
                }
            }
        }
        if back == 0, screen.cursorVisible {
            let (r, c) = screen.cursor
            let focused = window?.firstResponder === self
            let rect = NSRect(x: pad + CGFloat(c) * cellW, y: pad + CGFloat(r) * lineH, width: cellW, height: lineH)
            TerminalColors.cursor.withAlphaComponent(focused ? 0.75 : 0.35).setFill()
            focused ? rect.fill() : rect.frame()
        }
    }
}

/// The terminal's colours: Forge's background and text, a warm 16-colour palette, and xterm's 256-colour cube.
enum TerminalColors {
    static func hex(_ v: Int) -> NSColor {
        NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    }
    static let background = hex(0x1C1A17)
    static let foreground = hex(0xF7F5F1)
    static let cursor = hex(0xE59B47)
    /// Picked text: the heat colour, dimmed.
    static let selection = hex(0xE59B47).withAlphaComponent(0.32)
    static let base: [Int] = [
        0x2E2B27, 0xC2554A, 0x8FB069, 0xE3B25A, 0x6F9BD1, 0xB784C7, 0x6FB5AE, 0xD9D4CC,
        0x7A7470, 0xE0756A, 0xA9C985, 0xF0C878, 0x8DB4E6, 0xCFA0DD, 0x8DD0C9, 0xF7F5F1,
    ]

    static func color(_ i: Int) -> NSColor {
        if i >= 0x100_0000 { return hex(i & 0xFF_FFFF) }
        if i < 16 { return hex(base[max(i, 0)]) }
        if i < 232 {
            let v = i - 16
            let step = [0, 95, 135, 175, 215, 255]
            return hex(step[v / 36] << 16 | step[(v / 6) % 6] << 8 | step[v % 6])
        }
        let g = 8 + (min(i, 255) - 232) * 10
        return hex(g << 16 | g << 8 | g)
    }

    static func pair(_ a: TerminalScreen.Attr) -> (NSColor, NSColor?) {
        var fg = a.fg.map(color) ?? foreground
        var bg = a.bg.map(color)
        if a.inverse { (fg, bg) = (bg ?? background, fg) }
        return (fg, bg)
    }
}
