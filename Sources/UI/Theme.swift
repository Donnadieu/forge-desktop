import AppKit
import CoreText
import SwiftUI

/// The Forge Design System (Claude Design, `colors_and_type.css` and its UI kits): warm near-black,
/// cream text, amber heat as the only saturated accent, Playfair Display 900 for the wordmark and titles,
/// DM Sans for words, DM Mono for labels. Every view takes its colours, type and radii from here.
enum Theme {
    // Surfaces (--bg, --surface, --surface-hover, --surface-raised).
    static let bg = Color(hex: 0x1C1A17)
    static let surface = Color(hex: 0x2E2B27)
    static let surfaceHover = Color(hex: 0x38342F)
    static let surfaceRaised = Color(hex: 0x4A4640)
    // Borders (--border, --border-hover).
    static let border = Color(hex: 0x4A4640)
    static let borderHover = Color(hex: 0x7A7470)

    // The cream ramp (--silver-bright, --silver, --silver-mid, --silver-dim, --silver-faint) = text (--fg, --fg-2, --fg-3).
    static let text = Color(hex: 0xF7F5F1)
    static let silver = Color(hex: 0xEDE9E3)
    static let textSec = Color(hex: 0xB0A99F)
    // Muted was 0x7A7470 (3.8:1 on bg, 3.1:1 on surface): brightened to WCAG AA on both (Omar, Nov 13; typography.md).
    static let textMuted = Color(hex: 0x9A9490)
    static let faint = Color(hex: 0x4A4640)

    // Soft washes (--silver-wash-1/2/3): cream at 4, 8 and 14 percent.
    static let wash1 = text.opacity(0.04)
    static let wash2 = text.opacity(0.08)
    static let wash3 = text.opacity(0.14)

    // Heat, the one accent (--heat-warm, --heat-strong, --heat-deep, --heat-bg, --heat-border, --heat-glow).
    static let heat = Color(hex: 0xC47F2A)
    static let heatBright = Color(hex: 0xE59B47)
    static let heatDeep = Color(hex: 0x8A5519)
    static let heatWash = heat.opacity(0.10)
    static let heatBorder = heat.opacity(0.34)
    static let heatGlow = heat.opacity(0.18)

    // Semantic (--success, --warn, --danger, --info) with their -bg and -border washes.
    static let good = Color(hex: 0x5C8A3A)
    static let goodWash = good.opacity(0.12)
    static let goodBorder = good.opacity(0.40)
    static let warnWash = heat.opacity(0.10)
    static let warnBorder = heat.opacity(0.40)
    static let bad = Color(hex: 0x9B2B2B)
    static let badWash = bad.opacity(0.10)
    static let badBorder = bad.opacity(0.40)
    // Code colours (Syntax.swift): warm, on the same near-black, heat for keywords.
    static let codeKeyword = heatBright
    static let codeType = Color(hex: 0xE3C58F)
    static let codeString = Color(hex: 0x9DBF7A)
    static let codeNumber = Color(hex: 0xD9A37A)
    static let info = textSec
    static let infoWash = textSec.opacity(0.08)
    static let infoBorder = textSec.opacity(0.30)

    // Radii (--r-sm, --r-md, --r-lg, --r-xl).
    static let rSm: CGFloat = 2
    static let rMd: CGFloat = 4
    static let rLg: CGFloat = 8
    static let rXl: CGFloat = 14

    /// The top bar's height (the kit's TopNav). The window's own buttons sit in it.
    static let barHeight: CGFloat = 56

    /// A column's colour on the Orchestrator and the Workflow Studio screen, built from the system's tokens only.
    struct StageTone {
        let dot: Color
        let fill: Color
        let edge: Color
        let word: Color
        /// Backlog draws a hollow dot.
        var hollow = false
    }

    static func stage(_ name: String) -> StageTone {
        switch name {
        case "Backlog": return StageTone(dot: textMuted, fill: .clear, edge: border, word: textSec, hollow: true)
        case "Triage": return StageTone(dot: textMuted, fill: wash1, edge: border, word: textSec)
        case "Todo": return StageTone(dot: silver, fill: wash1, edge: borderHover, word: text)
        case "In Progress": return StageTone(dot: heatBright, fill: heatWash, edge: heatBorder, word: heatBright)
        case "AI Review": return StageTone(dot: info, fill: infoWash, edge: infoBorder, word: text)
        case "QA": return StageTone(dot: good, fill: goodWash, edge: goodBorder, word: text)
        case "Human Review": return StageTone(dot: text, fill: wash2, edge: borderHover, word: text)
        case "Rework": return StageTone(dot: bad, fill: badWash, edge: badBorder, word: text)
        case "Merging": return StageTone(dot: heatDeep, fill: .clear, edge: heatBorder, word: text)
        default: return StageTone(dot: faint, fill: .clear, edge: border, word: textSec)
        }
    }

    // Type. Every size is a `TextSize` token (Typography.swift): the scale and the zoom live there, never a number here.
    static func display(_ size: TextSize) -> Font { .custom("PlayfairDisplay-Black", fixedSize: size.points) }
    static func serifItalic(_ size: TextSize) -> Font { .custom("PlayfairDisplay-Italic", fixedSize: size.points) }
    /// `sans(size)` for AppKit views (the message box's text view, a chat message).
    static func sansFont(_ size: TextSize, _ weight: Font.Weight = .regular) -> NSFont {
        let name =
            switch weight {
            case .medium: "DMSans-Medium"
            case .semibold: "DMSans-SemiBold"
            case .bold, .heavy, .black: "DMSans-Bold"
            default: "DMSans-Regular"
            }
        return NSFont(name: name, size: size.points) ?? .systemFont(ofSize: size.points)
    }
    /// `mono(size)` for AppKit views.
    static func monoFont(_ size: TextSize) -> NSFont {
        NSFont(name: "DMMono-Regular", size: size.points) ?? .monospacedSystemFont(ofSize: size.points, weight: .regular)
    }
    static func sans(_ size: TextSize, _ weight: Font.Weight = .regular) -> Font {
        switch weight {
        case .medium: return .custom("DMSans-Medium", fixedSize: size.points)
        case .semibold: return .custom("DMSans-SemiBold", fixedSize: size.points)
        case .bold, .heavy, .black: return .custom("DMSans-Bold", fixedSize: size.points)
        default: return .custom("DMSans-Regular", fixedSize: size.points)
        }
    }
    static func mono(_ size: TextSize, _ weight: Font.Weight = .regular) -> Font {
        .custom(weight == .regular ? "DMMono-Regular" : "DMMono-Medium", fixedSize: size.points)
    }
    /// An SF Symbol next to text, at a glyph token.
    static func icon(_ size: TextSize, _ weight: Font.Weight = .regular) -> Font { .system(size: size.points, weight: weight) }
    /// A paragraph style that sets a token's line height (the chat's roomier lines).
    @discardableResult
    static func lines(_ size: TextSize, _ style: NSMutableParagraphStyle = NSMutableParagraphStyle()) -> NSMutableParagraphStyle {
        if let h = size.lineHeight {
            style.minimumLineHeight = h
            style.maximumLineHeight = h
        }
        return style
    }

    /// The eyebrow's tracking (--tr-mark, 0.14em) at its 10px size.
    static let labelTracking: CGFloat = 1.4

    /// The fonts ship inside the app (Resources/Fonts); register them before the first window draws.
    /// Returns how many registered, so the selftest can prove they load.
    @discardableResult
    static func registerFonts() -> Int {
        guard let dir = Bundle.main.resourceURL?.appendingPathComponent("Fonts"),
            let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
        else { return 0 }
        var count = 0
        for url in files where url.pathExtension == "ttf" {
            var error: Unmanaged<CFError>?
            // Already registered (a second call) counts as loaded.
            if CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error)
                || NSFont(name: url.deletingPathExtension().lastPathComponent, size: 12) != nil
            {
                count += 1
            }
        }
        return count
    }

    /// True when every face the screens use is available by name.
    static var fontsLoaded: Bool {
        [
            "PlayfairDisplay-Black", "PlayfairDisplay-Italic", "DMSans-Regular", "DMSans-Medium", "DMSans-SemiBold", "DMSans-Bold",
            "DMMono-Regular", "DMMono-Medium",
        ].allSatisfy { NSFont(name: $0, size: 12) != nil }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255,
            opacity: 1)
    }
}

/// The Forge anvil, from the design system's SVG (viewBox 8 8 100 56).
struct AnvilMark: Shape {
    func path(in rect: CGRect) -> Path {
        let sx = rect.width / 100
        let sy = rect.height / 56
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + (x - 8) * sx, y: rect.minY + (y - 8) * sy) }
        var path = Path()
        path.move(to: p(8, 36))
        path.addLine(to: p(25, 11))
        path.addQuadCurve(to: p(30, 8), control: p(27, 8))
        path.addLine(to: p(105, 8))
        path.addQuadCurve(to: p(108, 11), control: p(108, 8))
        path.addLine(to: p(108, 33))
        path.addQuadCurve(to: p(105, 36), control: p(108, 36))
        path.addLine(to: p(84, 36))
        path.addLine(to: p(84, 46))
        path.addLine(to: p(96, 46))
        path.addQuadCurve(to: p(98, 48), control: p(98, 46))
        path.addLine(to: p(98, 62))
        path.addQuadCurve(to: p(96, 64), control: p(98, 64))
        path.addLine(to: p(28, 64))
        path.addQuadCurve(to: p(26, 62), control: p(26, 64))
        path.addLine(to: p(26, 48))
        path.addQuadCurve(to: p(28, 46), control: p(26, 46))
        path.addLine(to: p(40, 46))
        path.addLine(to: p(40, 36))
        path.closeSubpath()
        return path
    }
}

extension AnvilMark {
    /// The mark at a given width, in the brand's proportions.
    func sized(_ width: CGFloat, _ color: Color = Theme.text) -> some View {
        fill(color).frame(width: width, height: width * 0.56)
    }
}
