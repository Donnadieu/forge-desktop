import SwiftUI

/// Buttons, chips, pills and fields in the Forge look. Screens use these instead of the stock styles.
struct ForgeButton: ButtonStyle {
    enum Kind {
        /// The one amber button that moves you forward.
        case primary
        /// A quiet surface button (Back, Workflow, Stop).
        case secondary
        /// The one fix under a problem line: amber words on an amber wash.
        case fix
        /// Words only (Skip for now, links).
        case plain
    }

    var kind: Kind = .secondary
    /// The keyboard shortcut drawn inside the button ("↵", "⌘[").
    var hint: String?
    var icon: String?
    var large = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 8) {
            if let icon { Image(systemName: icon).font(.system(size: 11, weight: .semibold)) }
            configuration.label.font(Theme.sans(large ? 14 : 13, .medium))
            if let hint { KeyHint(text: hint, onAmber: kind == .primary && enabled) }
        }
        .foregroundStyle(foreground)
        .padding(.leading, kind == .plain ? 0 : 12)
        .padding(.trailing, kind == .plain ? 0 : (hint == nil ? 12 : 6))
        .frame(height: kind == .plain ? nil : (large ? 32 : 28))
        .background(RoundedRectangle(cornerRadius: 6).fill(background(pressed: configuration.isPressed)))
        .contentShape(Rectangle())
        .opacity(configuration.isPressed && kind == .plain ? 0.7 : 1)
    }

    private var foreground: Color {
        guard enabled else { return Theme.textMuted }
        switch kind {
        case .primary: return Theme.bg
        case .secondary: return Theme.text
        case .fix, .plain: return Theme.heatBright
        }
    }

    private func background(pressed: Bool) -> Color {
        switch kind {
        case .primary: return enabled ? (pressed ? Theme.heatDeep : Theme.heat) : Theme.surface
        case .secondary: return pressed ? Theme.surfaceHover : Theme.surface
        case .fix: return Theme.heat.opacity(pressed ? 0.28 : 0.18)
        case .plain: return .clear
        }
    }
}

/// A keyboard shortcut drawn as a small key.
struct KeyHint: View {
    let text: String
    var onAmber = false

    var body: some View {
        Text(text)
            .font(Theme.mono(10))
            .foregroundStyle(onAmber ? Theme.bg.opacity(0.8) : Theme.textMuted)
            .padding(.horizontal, 4)
            .frame(minWidth: 18, minHeight: 18)
            .background(RoundedRectangle(cornerRadius: 4).fill(onAmber ? Color.black.opacity(0.14) : Color.white.opacity(0.06)))
    }
}

/// Small uppercase mono tag on a card or a row ("UP NEXT", "IN LINEAR", "RUNNING").
struct Chip: View {
    enum Tone { case quiet, heat, strong, good }
    let text: String
    var tone: Tone = .quiet
    var dot = false

    var body: some View {
        HStack(spacing: 5) {
            if dot { Circle().fill(color).frame(width: 5, height: 5) }
            Text(text.uppercased()).font(Theme.mono(10, .medium)).tracking(0.8)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 7)
        .frame(height: 19)
        .background(Capsule().fill(fill))
    }

    private var color: Color {
        switch tone {
        case .quiet: return Theme.textSec
        case .heat: return Theme.heatBright
        case .strong: return Theme.text
        case .good: return Theme.good
        }
    }

    private var fill: Color {
        switch tone {
        case .quiet: return Color.white.opacity(0.06)
        case .heat: return Theme.heat.opacity(0.16)
        case .strong: return Color.white.opacity(0.12)
        case .good: return Theme.good.opacity(0.14)
        }
    }
}

/// A rounded status pill with a dot: the board's "1 agent working", "Reading your board…".
struct StatusPill: View {
    let text: String
    var live = false
    var busy = false
    var dot = Theme.textMuted

    var body: some View {
        HStack(spacing: 7) {
            if busy {
                ProgressView().controlSize(.mini)
            } else {
                PulseDot(color: live ? Theme.heatBright : dot, pulsing: live)
            }
            Text(text).font(Theme.sans(12, .medium)).foregroundStyle(live ? Theme.heatBright : Theme.textSec)
        }
        .padding(.horizontal, 10)
        .frame(height: 24)
        .background(Capsule().fill(live ? Theme.heat.opacity(0.14) : Color.white.opacity(0.06)))
    }
}

/// A dot that breathes while something is live.
struct PulseDot: View {
    let color: Color
    var pulsing = false
    var size: CGFloat = 6
    @State private var on = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .shadow(color: pulsing ? color.opacity(0.8) : .clear, radius: 4)
            .opacity(pulsing ? (on ? 1 : 0.45) : 1)
            .onAppear {
                guard pulsing else { return }
                withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) { on = true }
            }
    }
}

/// Mono uppercase section label.
struct SectionLabel: View {
    let text: String
    var body: some View {
        Text(text.uppercased()).font(Theme.mono(11)).tracking(Theme.labelTracking).foregroundStyle(Theme.textMuted)
    }
}

/// Initials in a small circle (the person, at Human Review).
struct Initials: View {
    let name: String
    var size: CGFloat = 20

    var body: some View {
        let letters = name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
        Text(letters.isEmpty ? "?" : letters)
            .font(Theme.sans(size * 0.42, .semibold))
            .foregroundStyle(Theme.textSec)
            .frame(width: size, height: size)
            .background(Circle().fill(Theme.surfaceHover))
    }
}

/// The agent's mark on a card: the anvil in a small round well.
struct AgentGlyph: View {
    var size: CGFloat = 20
    var live = true

    var body: some View {
        AnvilMark().sized(size * 0.5, live ? Theme.heatBright : Theme.textMuted)
            .frame(width: size, height: size)
            .background(Circle().fill(live ? Theme.heat.opacity(0.16) : Color.white.opacity(0.06)))
    }
}

/// A grouped panel: surface tone and a soft edge instead of a hard outline.
struct Panel: ViewModifier {
    var fill = Theme.panel
    func body(content: Content) -> some View {
        content
            .background(RoundedRectangle(cornerRadius: 8).fill(fill))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.hairline))
    }
}

extension View {
    func panel(_ fill: Color = Theme.panel) -> some View { modifier(Panel(fill: fill)) }

    /// A text field in the Forge look (dark well, cream text), with its hint drawn while it's empty.
    func forgeField(mono: Bool = false, hint: String = "", empty: Bool = false) -> some View {
        textFieldStyle(.plain)
            .background(alignment: .leading) {
                if empty { Text(hint).font(mono ? Theme.mono(13) : Theme.sans(14)).foregroundStyle(Theme.textMuted).allowsHitTesting(false) }
            }
            .font(mono ? Theme.mono(13) : Theme.sans(14))
            .foregroundStyle(Theme.text)
            .padding(.horizontal, 12)
            .frame(height: 34)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.22)))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.border.opacity(0.7)))
    }
}
