import AppKit
import CoreText
import SwiftUI

/// The Forjado AI design system (the "Forge Design System" in Claude Design, and the tokens in Forge's own
/// web app): warm near-black, cream text, amber heat as the only saturated accent, Playfair Display for
/// headings, DM Sans for words, DM Mono for labels. Every view takes its colours and type from here.
enum Theme {
    // Surfaces, darkest to lightest.
    static let bg = Color(hex: 0x1C1A17)
    static let sidebar = Color(hex: 0x201E1B)
    static let panel = Color(hex: 0x24221F)
    static let surface = Color(hex: 0x2E2B27)
    static let surfaceHover = Color(hex: 0x38342F)
    static let border = Color(hex: 0x4A4640)
    static let hairline = Color.white.opacity(0.06)

    // Text.
    static let text = Color(hex: 0xF7F5F1)
    static let textSec = Color(hex: 0xB0A99F)
    static let textMuted = Color(hex: 0x7A7470)

    // Heat: the one accent. Amber, not orange.
    static let heat = Color(hex: 0xC47F2A)
    static let heatBright = Color(hex: 0xE59B47)
    static let heatDeep = Color(hex: 0x8A5519)
    static let heatWash = Color(hex: 0xC47F2A).opacity(0.12)

    // Status.
    static let good = Color(hex: 0x6FA34A)
    static let bad = Color(hex: 0xF87171)

    /// Each column's dot on the board and the Project screen: greys for waiting, amber while agents
    /// work, a ring for your turn, green once it's merging or done.
    static func columnDot(_ name: String) -> (color: Color, ring: Bool) {
        switch name {
        case "Backlog": return (textMuted, false)
        case "Triage": return (textSec, false)
        case "Todo": return (text, false)
        case "In Progress": return (heat, false)
        case "AI Review", "QA": return (heatBright, false)
        case "Human Review": return (heatBright, true)
        case "Rework": return (heatDeep, false)
        case "Merging", "Done": return (good, false)
        default: return (textMuted, false)
        }
    }

    // Type.
    static func display(_ size: CGFloat) -> Font { .custom("PlayfairDisplay-ExtraBold", size: size) }
    static func serif(_ size: CGFloat) -> Font { .custom("PlayfairDisplay-Bold", size: size) }
    static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        switch weight {
        case .medium: return .custom("DMSans-Medium", size: size)
        case .semibold: return .custom("DMSans-SemiBold", size: size)
        case .bold, .heavy, .black: return .custom("DMSans-Bold", size: size)
        default: return .custom("DMSans-Regular", size: size)
        }
    }
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom(weight == .regular ? "DMMono-Regular" : "DMMono-Medium", size: size)
    }

    /// Small uppercase mono label ("SETUP", "GUARDRAILS", "AGENT NOW").
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
            "PlayfairDisplay-ExtraBold", "PlayfairDisplay-Bold", "DMSans-Regular", "DMSans-Medium", "DMSans-SemiBold", "DMSans-Bold",
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

/// The Forjado AI anvil, from the brand's SVG (viewBox 8 8 100 56).
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
