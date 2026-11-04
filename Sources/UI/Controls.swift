import SwiftUI

/// Buttons, keys, pills, chips, dots and fields from the design system's kit (`.btn`, `.kbd`, `.pill`,
/// `.chip`, `.dot`, `.input`). Screens use these instead of the stock styles.
struct ForgeButton: ButtonStyle {
    enum Kind {
        /// `.btn.primary`: the one amber button that moves you forward (and the one fix under a problem).
        case primary
        /// `.btn`: a surface button with a border (Back, Stop, Change).
        case secondary
        /// `.btn.ghost`: words on nothing until hovered (Workflow, Settings, Back to Orchestrator).
        case ghost
        /// The one fix under a problem line; drawn as the primary button.
        case fix
        /// A text link (`a`): quiet words with a hairline under them.
        case plain
    }

    var kind: Kind = .secondary
    /// The keyboard shortcut drawn inside the button ("↵", "⌘[").
    var hint: String?
    var icon: String?
    /// `.btn` (36 high) when true, `.btn.sm` (28 high) when false.
    var large = false
    @Environment(\.isEnabled) private var enabled
    @State private var hover = false

    private var amber: Bool { kind == .primary || kind == .fix }

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 8) {
            if let icon { Image(systemName: icon).font(.system(size: large ? 12 : 11, weight: .medium)) }
            configuration.label.font(Theme.sans(kind == .plain ? 11 : (large ? 12 : 11), amber ? .semibold : .medium))
            if let hint { KeyHint(text: hint, onAmber: amber) }
        }
        .lineLimit(1)
        .fixedSize()
        .foregroundStyle(foreground)
        .padding(.horizontal, kind == .plain ? 0 : (large ? 16 : 12))
        .frame(height: kind == .plain ? nil : (large ? 36 : 28))
        .background(shape.fill(background(pressed: configuration.isPressed)))
        .overlay(shape.stroke(edge, lineWidth: 1))
        .overlay(alignment: .bottom) {
            if kind == .plain { Rectangle().fill(hover ? Theme.borderHover : Theme.border).frame(height: 1).offset(y: 2) }
        }
        .shadow(color: amber && enabled ? Theme.heatGlow : .clear, radius: 12)
        .opacity(enabled ? 1 : 0.4)
        .contentShape(Rectangle())
        .onHover { hover = $0 }
    }

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: large ? (amber ? Theme.rLg : Theme.rMd) : Theme.rSm)
    }

    private var foreground: Color {
        switch kind {
        case .primary, .fix: return Theme.bg
        case .secondary: return Theme.text
        case .ghost: return hover ? Theme.text : Theme.textSec
        case .plain: return hover ? Theme.text : Theme.textSec
        }
    }

    private var edge: Color {
        switch kind {
        case .primary, .fix: return Theme.heatBorder
        case .secondary: return hover ? Theme.borderHover : Theme.border
        case .ghost, .plain: return .clear
        }
    }

    private func background(pressed: Bool) -> Color {
        switch kind {
        case .primary, .fix: return pressed ? Theme.heatDeep : (hover && enabled ? Theme.heatBright : Theme.heat)
        case .secondary: return hover || pressed ? Theme.surfaceHover : Theme.surface
        case .ghost: return hover ? Theme.surface : .clear
        case .plain: return .clear
        }
    }
}

/// `.kbd`: a keyboard shortcut drawn as a small key.
struct KeyHint: View {
    let text: String
    var onAmber = false

    var body: some View {
        Text(text)
            .font(Theme.mono(10))
            .foregroundStyle(onAmber ? Theme.bg : Theme.textSec)
            .padding(.horizontal, 4)
            .frame(minWidth: 18, minHeight: 18)
            .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(onAmber ? .clear : Theme.surface))
            .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(onAmber ? Theme.heatDeep : Theme.border))
    }
}

/// `.pill`: a rounded status pill, 22 high (heat, green, amber, info, ghost, or a column's colour).
struct Pill: View {
    enum Tone { case neutral, heat, green, amber, info, ghost }
    let text: String
    var tone: Tone = .neutral
    /// A column's colour instead of a tone.
    var stage: String?
    var dot: Color?
    var pulsing = false
    var spinning = false

    var body: some View {
        HStack(spacing: 8) {
            if spinning { Spinner(heat: tone == .heat || tone == .amber) }
            if let dot { PulseDot(color: dot, pulsing: pulsing) }
            Text(text).font(Theme.sans(10, .semibold)).tracking(0.4)
        }
        .foregroundStyle(colors.word)
        .padding(.horizontal, 12)
        .frame(height: 22)
        .background(Capsule().fill(colors.fill))
        .overlay(Capsule().stroke(colors.edge))
        .fixedSize()
    }

    private var colors: (fill: Color, edge: Color, word: Color) {
        if let stage {
            let s = Theme.stage(stage)
            return (s.fill, s.edge, s.word)
        }
        switch tone {
        case .neutral: return (Theme.surface, Theme.border, Theme.textSec)
        case .heat: return (Theme.heatWash, Theme.heatBorder, Theme.heatBright)
        case .green: return (Theme.goodWash, Theme.goodBorder, Theme.good)
        case .amber: return (Theme.warnWash, Theme.warnBorder, Theme.heat)
        case .info: return (Theme.infoWash, Theme.infoBorder, Theme.info)
        case .ghost: return (.clear, Theme.border, Theme.textSec)
        }
    }
}

/// `.chip`: a small mono tag (on: Todo, Missing, agent).
struct Chip: View {
    enum Tone { case quiet, heat, dim, warn, good }
    let text: String
    var tone: Tone = .quiet

    var body: some View {
        Text(text)
            .font(Theme.mono(10.5))
            .foregroundStyle(word)
            .padding(.horizontal, 8)
            .frame(height: 20)
            .background(RoundedRectangle(cornerRadius: Theme.rSm).fill(fill))
            .overlay(RoundedRectangle(cornerRadius: Theme.rSm).stroke(edge))
            .fixedSize()
    }

    private var word: Color {
        switch tone {
        case .quiet: return Theme.textSec
        case .heat: return Theme.heatBright
        case .dim: return Theme.textMuted
        case .warn: return Theme.heat
        case .good: return Theme.good
        }
    }
    private var fill: Color {
        switch tone {
        case .quiet: return Theme.wash1
        case .heat: return Theme.heatWash
        case .dim: return .clear
        case .warn: return Theme.warnWash
        case .good: return Theme.goodWash
        }
    }
    private var edge: Color {
        switch tone {
        case .heat: return Theme.heatBorder
        case .warn: return Theme.warnBorder
        case .good: return Theme.goodBorder
        default: return Theme.border
        }
    }
}

/// `.dot`: a status dot that breathes while something is live (`.dot.amber`).
struct PulseDot: View {
    let color: Color
    var pulsing = false
    var size: CGFloat = 8
    @State private var on = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .shadow(color: pulsing ? Theme.heatGlow : .clear, radius: 4)
            .opacity(pulsing ? (on ? 1 : 0.5) : 1)
            .onAppear {
                guard pulsing else { return }
                withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) { on = true }
            }
    }
}

/// `.sdot`: a column's colour dot (hollow for Backlog).
struct StageDot: View {
    let stage: String
    var body: some View {
        let s = Theme.stage(stage)
        Circle().fill(s.hollow ? .clear : s.dot).overlay(Circle().stroke(s.hollow ? s.dot : .clear)).frame(width: 8, height: 8)
    }
}

/// `.spinner`: 12px ring, its top in cream (or heat).
struct Spinner: View {
    var heat = false
    @State private var turn = false

    var body: some View {
        Circle()
            .stroke(Theme.wash2, lineWidth: 1.5)
            .overlay(Circle().trim(from: 0, to: 0.25).stroke(heat ? Theme.heat : Theme.textSec, lineWidth: 1.5))
            .frame(width: 12, height: 12)
            .rotationEffect(.degrees(turn ? 360 : 0))
            .onAppear { withAnimation(.linear(duration: 1).repeatForever(autoreverses: false)) { turn = true } }
    }
}

/// `.eyebrow`: mono uppercase label, 10px, tracking 0.14em.
struct SectionLabel: View {
    let text: String
    var color = Theme.textMuted
    var body: some View {
        Text(text.uppercased()).font(Theme.mono(10, .medium)).tracking(Theme.labelTracking).foregroundStyle(color)
    }
}

/// `.av`: initials in a small round well.
struct Initials: View {
    let name: String
    var size: CGFloat = 32

    var body: some View {
        let letters = name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
        Text(letters.isEmpty ? "?" : letters)
            .font(Theme.sans(11, .semibold))
            .foregroundStyle(Theme.text)
            .frame(width: size, height: size)
            .background(Circle().fill(Theme.surfaceRaised))
            .overlay(Circle().stroke(Theme.border))
    }
}

/// `.tg`: the amber switch.
struct ForgeToggle: View {
    @Binding var on: Bool

    var body: some View {
        ZStack(alignment: on ? .trailing : .leading) {
            Capsule().fill(on ? Theme.heatWash : Theme.wash1).overlay(Capsule().stroke(on ? Theme.heatBorder : Theme.border))
            Circle().fill(on ? Theme.heat : Theme.textMuted).frame(width: 13, height: 13).padding(2)
                .shadow(color: on ? Theme.heatGlow : .clear, radius: 6)
        }
        .frame(width: 34, height: 19)
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.easeOut(duration: 0.2)) { on.toggle() } }
        .accessibilityAddTraits(.isButton)
    }
}

/// `.panel`: a surface with a border, radius 8 (and `.panel.live`: heat edge and glow).
struct Panel: ViewModifier {
    var fill = Theme.surface
    var live = false
    func body(content: Content) -> some View {
        content
            .background(RoundedRectangle(cornerRadius: Theme.rLg).fill(fill))
            .overlay(RoundedRectangle(cornerRadius: Theme.rLg).stroke(live ? Theme.heatBorder : Theme.border))
            .shadow(color: live ? Theme.heatGlow : .clear, radius: 12)
    }
}

extension View {
    func panel(_ fill: Color = Theme.surface, live: Bool = false) -> some View { modifier(Panel(fill: fill, live: live)) }

    /// `.input`: a field 40 high on the canvas colour, radius 8, its hint drawn while it's empty, and an
    /// optional icon on the left inside the box (the lock on a key).
    func forgeField(mono: Bool = false, hint: String = "", empty: Bool = false, icon: String? = nil) -> some View {
        HStack(spacing: 8) {
            if let icon { Image(systemName: icon).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.textMuted) }
            textFieldStyle(.plain)
                .background(alignment: .leading) {
                    if empty { Text(hint).font(mono ? Theme.mono(13) : Theme.sans(13)).foregroundStyle(Theme.textMuted).allowsHitTesting(false) }
                }
                .font(mono ? Theme.mono(13) : Theme.sans(13))
                .foregroundStyle(Theme.text)
        }
        .padding(.horizontal, 12)
        .frame(height: 40)
        .background(RoundedRectangle(cornerRadius: Theme.rLg).fill(Theme.bg))
        .overlay(RoundedRectangle(cornerRadius: Theme.rLg).stroke(Theme.border))
    }
}
