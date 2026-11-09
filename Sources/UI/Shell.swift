import SwiftUI

/// The pieces every screen shares, from the design system's kits: the top bar (`.topnav` with the Brand
/// lockup), the atmosphere behind the page, the page header (`.phead`) and the sticky bottom bar (`.bar`).
struct TopBar<Right: View>: View {
    /// The mono word after the wordmark ("SETUP", "ORCHESTRATOR").
    let suffix: String
    @ViewBuilder var right: () -> Right
    /// The workspace chip shows when the app's model is around (always, except in checks that draw a bar alone).
    @Environment(\.forgeModel) private var model

    var body: some View {
        HStack(spacing: 12) {
            HStack(spacing: 8) {
                AnvilMark().sized(32)
                Text(AppInfo.name).font(Theme.display(20)).foregroundStyle(Theme.text).fixedSize()
                if let model { WorkspaceChip(model: model).padding(.leading, 8) }
                if let model, ScreenSwitch.screens.contains(suffix) {
                    ScreenSwitch(model: model, shown: suffix).padding(.leading, 8)
                } else {
                    Text(suffix.uppercased()).font(Theme.mono(11, .medium)).tracking(1.5).foregroundStyle(Theme.textSec).padding(.leading, 8)
                }
            }
            Spacer(minLength: 16)
            right()
        }
        // Room on the left for the window's own three buttons.
        .padding(.leading, 96)
        .padding(.trailing, 24)
        .frame(height: Theme.barHeight)
        .background(Theme.bg.opacity(0.85))
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
    }
}

extension TopBar where Right == EmptyView {
    init(suffix: String) { self.init(suffix: suffix) { EmptyView() } }
}

/// The Orchestrator | Sessions switch in the top bar: the board Forge works on its own, or the chats you have
/// with agents (docs/design/sessions.md, Direction A).
struct ScreenSwitch: View {
    static let screens = ["Orchestrator", "Sessions"]
    @ObservedObject var model: AppModel
    let shown: String

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Self.screens, id: \.self) { name in
                Button {
                    model.go(name == "Sessions" ? AppModel.sessionsScreen : AppModel.boardScreen)
                } label: {
                    Text(name.uppercased()).font(Theme.mono(10, .medium)).tracking(1)
                        .foregroundStyle(name == shown ? Theme.text : Theme.textMuted)
                        .padding(.horizontal, 8).frame(height: 26)
                        .background(name == shown ? Theme.surfaceHover : .clear)
                }
                .buttonStyle(.plain)
            }
        }
        .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(Theme.bg))
        .clipShape(RoundedRectangle(cornerRadius: Theme.rMd))
        .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.border))
        .fixedSize()
    }
}

/// `.atmosphere`: a soft cream glow at the top of the canvas and a faint heat glow at the bottom.
struct Atmosphere: View {
    var body: some View {
        ZStack {
            Theme.bg
            RadialGradient(colors: [Theme.wash2, .clear], center: UnitPoint(x: 0.5, y: -0.1), startRadius: 0, endRadius: 700)
            RadialGradient(colors: [Theme.heatGlow, .clear], center: UnitPoint(x: 0.5, y: 1.0), startRadius: 0, endRadius: 520)
                .opacity(0.7)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

/// `.phead`: mono eyebrow, the Playfair title (40), one lead line, and a hairline under it.
struct PageHeader<Aside: View>: View {
    let eyebrow: String
    let title: String
    let lead: String
    @ViewBuilder var aside: () -> Aside

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .bottom, spacing: 32) {
                VStack(alignment: .leading, spacing: 0) {
                    SectionLabel(text: eyebrow)
                    Text(title).font(Theme.display(40)).foregroundStyle(Theme.text).padding(.top, 8)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(lead).font(Theme.sans(13)).foregroundStyle(Theme.textSec).lineSpacing(4).padding(.top, 8)
                        .frame(maxWidth: 560, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                aside()
            }
            .padding(.bottom, 24)
            Rectangle().fill(Theme.border).frame(height: 1)
        }
        .padding(.bottom, 24)
    }
}

extension PageHeader where Aside == EmptyView {
    init(eyebrow: String, title: String, lead: String) { self.init(eyebrow: eyebrow, title: title, lead: lead) { EmptyView() } }
}

/// `.bar`: the sticky bottom bar, a status line on the left and the actions on the right.
struct BottomBar<Status: View, Actions: View>: View {
    @ViewBuilder var status: () -> Status
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        HStack(spacing: 20) {
            status().font(Theme.sans(13)).foregroundStyle(Theme.textMuted)
            Spacer(minLength: 12)
            HStack(spacing: 8) { actions() }
        }
        .padding(.horizontal, 40)
        .padding(.vertical, 12)
        .background(Theme.bg.opacity(0.88))
        .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
    }
}

/// The window's three buttons, drawn only in screen renders (the real window draws its own).
struct TrafficLights: View {
    var body: some View {
        // macOS's own close, minimise and zoom colours: OS chrome, not Forge's tokens.
        HStack(spacing: 8) {
            ForEach([0xFF5F57, 0xFEBC2E, 0x28C840] as [UInt32], id: \.self) { Circle().fill(Color(hex: $0)).frame(width: 12, height: 12) }
        }
        .padding(.leading, 20)
        .frame(height: Theme.barHeight)
    }
}

/// `.notice`: a problem in warn washes (no coloured rail): the problem line, then its one fix right under it.
struct Notice<Fix: View>: View {
    let title: String
    var detail: String?
    var mono = false
    var icon = "exclamationmark.triangle"
    @ViewBuilder var fix: () -> Fix

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: icon).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.heat)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(Theme.sans(13, .medium)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
                    if let detail {
                        Text(detail).font(mono ? Theme.mono(11) : Theme.sans(11)).foregroundStyle(Theme.textSec)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            fix()
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.rLg).fill(Theme.warnWash))
        .overlay(RoundedRectangle(cornerRadius: Theme.rLg).stroke(Theme.warnBorder))
    }
}

extension Notice where Fix == EmptyView {
    init(title: String, detail: String? = nil, mono: Bool = false) { self.init(title: title, detail: detail, mono: mono) { EmptyView() } }
}

/// A short plain-words problem line under a field, as a notice.
struct ProblemLine: View {
    let text: String?

    var body: some View {
        if let text { Notice(title: text).padding(.top, 12) }
    }
}

/// `.checkline`: a short plain-words "all good" line with a green dot.
struct GoodLine: View {
    let text: String

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(Theme.good).frame(width: 8, height: 8).shadow(color: Theme.goodBorder, radius: 4)
            Text(text).font(Theme.sans(13)).foregroundStyle(Theme.textSec)
        }
    }
}
