import AppKit
import Observation
import SwiftUI

/// One size on Forge's type scale (docs/design/typography.md). Every text and icon size in the app is one of these:
/// its points come from the token and the window's zoom, never from a number at the call site (lint `type-tokens`).
/// There is no literal initialiser on purpose: `Theme.sans(13)` doesn't compile.
struct TextSize: Hashable, Sendable {
    /// Points at 100% zoom.
    let base: CGFloat
    /// The line height body text is set at (points at 100%); nil keeps the font's own.
    let leading: CGFloat?
    /// False for text that sits in a box of a fixed size (an avatar's initials): it never grows out of its box.
    let zooms: Bool

    private init(_ base: CGFloat, leading: CGFloat? = nil, zooms: Bool = true) {
        self.base = base
        self.leading = leading
        self.zooms = zooms
    }

    /// The size to draw at the current zoom.
    var points: CGFloat { zooms ? Zoom.shared.scaled(base) : base }
    /// The line height to set at the current zoom, when the token has one.
    var lineHeight: CGFloat? { leading.map { zooms ? Zoom.shared.scaled($0) : $0 } }

    // MARK: The app's scale: setup, Settings, Workflow Studio, sheets, controls, and the Sessions panes' chrome
    // (sessions list, tabs, header, Changes panel). One step up from 0.2.42's sizes (in brackets).

    /// Mono eyebrows, counts and keys (10).
    static let label = TextSize(11)
    /// Hints, statuses and small buttons (11).
    static let caption = TextSize(12)
    /// Secondary lines and list details (12).
    static let small = TextSize(13)
    /// The app's reading size: rows, fields, leads (13).
    static let body = TextSize(14)
    /// Panel titles and emphasised rows (14).
    static let emphasis = TextSize(15)
    /// Section titles (15).
    static let subtitle = TextSize(16)
    /// A card's title in its detail panel (16).
    static let title = TextSize(17)

    // MARK: Display (Playfair Display and big mono): the kit's own sizes, unchanged.

    /// "Forge" in the top bar.
    static let wordmark = TextSize(20)
    /// A sheet's title.
    static let sheetTitle = TextSize(24)
    /// The empty board's line ("Nothing on the anvil yet").
    static let emptyTitle = TextSize(24)
    /// The Orchestrator's headline.
    static let headline = TextSize(38)
    /// A page's title.
    static let pageTitle = TextSize(40)
    /// A stat card's number.
    static let stat = TextSize(40)
    /// A device sign-in code people type.
    static let codeDisplay = TextSize(28)
    /// A device sign-in code in a narrow row.
    static let codeDisplaySmall = TextSize(22)
    /// The open session's title, and in a narrow chat (26, 20).
    static let sessionTitle = TextSize(28)
    static let sessionTitleCompact = TextSize(22)

    // MARK: Sessions: the chat, where people read the most. Conductor's size or larger, roomy lines.

    /// A message's words (13, about 1.3 lines): Conductor sets 14 pt, Forge's DM Sans is smaller on the eye.
    static let chatBody = TextSize(16, leading: 24)
    /// A message's headings (15, 14).
    static let chatHeading = TextSize(19, leading: 26)
    static let chatSubheading = TextSize(17, leading: 24)
    /// Code blocks and `code` in a message (11 and 12).
    static let chatCode = TextSize(14, leading: 21)
    /// A table in a message (13, header 12).
    static let chatTable = TextSize(15, leading: 22)
    /// The message box (13).
    static let composer = TextSize(16, leading: 24)
    /// Cards in the chat: questions, plans, setup (13).
    static let chatText = TextSize(15)
    /// Notes and a tool row's detail (12).
    static let chatNote = TextSize(14)
    /// Delivery marks, times, "Earlier turns" (11).
    static let chatCaption = TextSize(13)
    /// A tool row's name and path, in mono (11).
    static let toolTitle = TextSize(13)
    /// A tool row's counts, in mono (10).
    static let toolMeta = TextSize(12)
    /// A diff's lines (11) and their numbers (10).
    static let diffCode = TextSize(13)
    static let diffNumber = TextSize(12)
    /// The session's Terminal (12).
    static let terminal = TextSize(13)

    // MARK: The Orchestrator board: compact on purpose, half a step up.

    /// Card titles and what an agent is doing (13).
    static let boardText = TextSize(13.5)
    /// Card ids, PR numbers, times, table titles (11).
    static let boardMono = TextSize(11.5)
    /// Small words on the board (11).
    static let boardSmall = TextSize(11.5)
    /// A stat card's note (10.5).
    static let boardNote = TextSize(11)
    /// A quiet line in an empty table (14, italic).
    static let boardQuiet = TextSize(14.5)

    // MARK: Icons (SF Symbols next to text). Same sizes as before; they follow the zoom.

    static let glyphTiny = TextSize(8)
    static let glyphXS = TextSize(9)
    static let glyphS = TextSize(10)
    static let glyph = TextSize(11)
    static let glyphM = TextSize(12)
    static let glyphL = TextSize(13)
    static let glyphXL = TextSize(14)

    /// The thin empty line that keeps a code panel off the words above it.
    static let spacer = TextSize(4, zooms: true)

    /// Initials inside an avatar of a fixed size.
    static func initials(in box: CGFloat) -> TextSize { TextSize(box * 0.42, zooms: false) }

    /// An icon inside a tile of a fixed size.
    static func glyphIn(_ box: CGFloat) -> TextSize { TextSize(box * 0.45, zooms: false) }

    /// Every named token, for the checks.
    static let all: [TextSize] = [
        label, caption, small, body, emphasis, subtitle, title, wordmark, sheetTitle, emptyTitle, headline, pageTitle, stat,
        codeDisplay, codeDisplaySmall, sessionTitle, sessionTitleCompact, chatBody, chatHeading, chatSubheading, chatCode, chatTable,
        composer, chatText, chatNote, chatCaption, toolTitle, toolMeta, diffCode, diffNumber, terminal, boardText, boardMono,
        boardSmall, boardNote, boardQuiet,
    ]
}

/// The window's zoom (View > Zoom In ⌘+, Zoom Out ⌘-, Actual Size ⌘0), remembered across launches. Every `TextSize`
/// reads it, so all text, icons and the layout around them grow together; SwiftUI redraws whatever read it.
@Observable
final class Zoom {
    static let shared = Zoom(defaults: .standard)
    static let steps: [Double] = [0.85, 0.9, 1, 1.1, 1.25, 1.5]
    static let key = "forge.zoom"

    @ObservationIgnored private let defaults: UserDefaults
    private(set) var level: Double

    init(defaults: UserDefaults) {
        self.defaults = defaults
        level = Self.nearest(defaults.object(forKey: Self.key) as? Double ?? 1)
    }

    var canZoomIn: Bool { level < Self.steps.last! - 0.001 }
    var canZoomOut: Bool { level > Self.steps.first! + 0.001 }
    var isActualSize: Bool { abs(level - 1) < 0.001 }
    var percent: Int { Int((level * 100).rounded()) }

    func zoomIn() { set(Self.steps.first { $0 > level + 0.001 } ?? level) }
    func zoomOut() { set(Self.steps.last { $0 < level - 0.001 } ?? level) }
    func reset() { set(1) }

    /// Sets the zoom; `persist: false` only draws at it (checks and renders never touch the person's setting).
    func set(_ value: Double, persist: Bool = true) {
        let v = Self.nearest(value)
        if v != level { level = v }
        if persist { defaults.set(v, forKey: Self.key) }
    }

    /// A size at this zoom, on a half-point grid so text stays crisp.
    func scaled(_ base: CGFloat) -> CGFloat { (base * CGFloat(level) * 2).rounded() / 2 }

    /// ⌘= zooms in like ⌘+ (the menu can hold one key per item). True when the key was taken.
    func handlesKey(_ e: NSEvent) -> Bool {
        guard e.type == .keyDown, e.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
            e.charactersIgnoringModifiers == "="
        else { return false }
        zoomIn()
        return true
    }

    static func nearest(_ v: Double) -> Double { steps.min { abs($0 - v) < abs($1 - v) } ?? 1 }

    /// Draws `body` at a zoom without saving it, then puts the zoom back.
    @MainActor static func drawing<T>(at level: Double, _ body: () -> T) -> T {
        let before = shared.level
        shared.set(level, persist: false)
        defer { shared.set(before, persist: false) }
        return body()
    }
}

/// View > Zoom In, Zoom Out, Actual Size.
struct ZoomCommands: Commands {
    var body: some Commands {
        CommandGroup(before: .toolbar) {
            Button("Zoom In") { Zoom.shared.zoomIn() }
                .keyboardShortcut("+", modifiers: .command)
                .disabled(!Zoom.shared.canZoomIn)
            // ⌘= (the same key without Shift) zooms in too: `Zoom.handlesKey`, from the app's key monitor.
            Button("Zoom Out") { Zoom.shared.zoomOut() }
                .keyboardShortcut("-", modifiers: .command)
                .disabled(!Zoom.shared.canZoomOut)
            Button("Actual Size") { Zoom.shared.reset() }
                .keyboardShortcut("0", modifiers: .command)
                .disabled(Zoom.shared.isActualSize)
            Divider()
        }
    }
}
