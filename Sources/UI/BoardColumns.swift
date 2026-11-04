import SwiftUI

/// The board's columns side by side. Columns with cards share the width; empty ones fold into thin
/// strips, so all ten fit in the window without scrolling sideways.
struct BoardColumns: View {
    let columns: [EngineState.Column]
    let paused: Bool
    var loading = false
    @Binding var open: EngineState.Card?

    static let strip: CGFloat = 40
    static let gap: CGFloat = 8
    static let minWide: CGFloat = 168

    var body: some View {
        GeometryReader { geo in
            let wide = columns.filter { loading || !$0.cards.isEmpty }
            let narrow = columns.count - wide.count
            let room = geo.size.width - 32 - CGFloat(columns.count - 1) * Self.gap - CGFloat(narrow) * Self.strip
            let each = wide.isEmpty ? 0 : max(loading ? 0 : Self.minWide, room / CGFloat(wide.count))
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: Self.gap) {
                    ForEach(columns) { c in
                        if loading || !c.cards.isEmpty {
                            ColumnView(column: c, paused: paused, loading: loading, open: $open).frame(width: each)
                        } else {
                            ColumnStrip(column: c).frame(width: Self.strip)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
                .frame(minHeight: geo.size.height, alignment: .top)
            }
        }
    }
}

/// An empty column, folded: its dot, a zero, and its name running down.
struct ColumnStrip: View {
    let column: EngineState.Column

    var body: some View {
        VStack(spacing: 8) {
            ColumnDot(name: column.name)
            Text("0").font(Theme.mono(10)).foregroundStyle(Theme.textMuted)
            Text(column.name)
                .font(Theme.sans(12))
                .foregroundStyle(Theme.textMuted)
                .fixedSize()
                .rotationEffect(.degrees(90))
                .frame(width: 20, height: 90)
            Spacer()
        }
        .padding(.top, 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.panel.opacity(0.7)))
    }
}

struct ColumnDot: View {
    let name: String

    var body: some View {
        let d = Theme.columnDot(name)
        Group {
            if d.ring { Circle().stroke(d.color, lineWidth: 1.5) } else { Circle().fill(d.color) }
        }
        .frame(width: 7, height: 7)
    }
}

struct ColumnView: View {
    let column: EngineState.Column
    let paused: Bool
    var loading = false
    @Binding var open: EngineState.Card?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ColumnDot(name: column.name)
                Text(column.name).font(Theme.sans(13, .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                if !loading { Text("\(column.cards.count)").font(Theme.mono(11)).foregroundStyle(Theme.textMuted) }
            }
            .padding(.horizontal, 4)
            .padding(.bottom, 2)
            if loading {
                ForEach(0..<2, id: \.self) { _ in RoundedRectangle(cornerRadius: 8).fill(Theme.surface.opacity(0.5)).frame(height: 64) }
            }
            ForEach(column.cards) { card in
                CardView(card: card, paused: paused).onTapGesture { open = card }
            }
            Spacer(minLength: 0)
        }
        .padding(8)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.panel.opacity(0.7)))
    }
}

struct CardView: View {
    let card: EngineState.Card
    let paused: Bool

    private var working: Bool { card.agent != nil }
    private var yourTurn: Bool { card.state == "Human Review" }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(card.identifier).font(Theme.mono(11)).foregroundStyle(working ? Theme.heatBright : Theme.textMuted)
                Spacer()
                CardChip(card: card)
            }
            Text(card.title).font(Theme.sans(14, .medium)).foregroundStyle(Theme.text).lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
            if let line = card.activity, card.agent != nil {
                HStack(alignment: .top, spacing: 8) {
                    AgentGlyph(live: working)
                    Text(line).font(Theme.sans(13)).foregroundStyle(Theme.textSec).lineLimit(2)
                }
            } else if yourTurn {
                HStack(alignment: .top, spacing: 8) {
                    if let who = card.assignee { Initials(name: who) }
                    Text("Your turn: look at the pull request").font(Theme.sans(13)).foregroundStyle(Theme.textSec).lineLimit(2)
                }
            }
            footer
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(working ? Theme.heat.opacity(0.10) : Theme.surface.opacity(0.75)))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(working ? Theme.heat.opacity(0.55) : Theme.hairline))
        .shadow(color: working ? Theme.heat.opacity(0.35) : .black.opacity(0.18), radius: working ? 14 : 3, y: working ? 0 : 1)
        .opacity(paused ? 0.6 : 1)
        .contentShape(Rectangle())
    }

    @ViewBuilder private var footer: some View {
        let helpers = card.helpers.filter(\.running)
        if !helpers.isEmpty || card.prUrl != nil {
            VStack(alignment: .leading, spacing: 0) {
                if !helpers.isEmpty { Rectangle().fill(Theme.hairline).frame(height: 1).padding(.bottom, 8) }
                HStack(alignment: .bottom, spacing: 8) {
                    if !helpers.isEmpty {
                        Text("\(helpers.count) helper\(helpers.count == 1 ? "" : "s"): \(helpers.map(\.description).joined(separator: ", "))")
                            .font(Theme.sans(12)).foregroundStyle(Theme.textMuted).lineLimit(3)
                    }
                    Spacer(minLength: 0)
                    if let pr = card.prUrl { PRChip(url: pr) }
                }
            }
        }
    }
}

/// One word for where a card stands: Working, Your turn, Up next, Later or Done.
struct CardChip: View {
    let card: EngineState.Card

    var body: some View {
        let (text, tone, dot) = Self.label(card)
        Chip(text: text, tone: tone, dot: dot)
    }

    static func label(_ card: EngineState.Card) -> (String, Chip.Tone, Bool) {
        if card.agent != nil { return ("Working", .heat, true) }
        switch card.state {
        case "Human Review": return ("Your turn", .strong, false)
        case "Backlog": return ("Later", .quiet, false)
        case "Done": return ("Done", .good, false)
        default: return ("Up next", .quiet, false)
        }
    }
}

/// The pull request number, as a small chip.
struct PRChip: View {
    let url: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "arrow.triangle.pull").font(.system(size: 10))
            Text(url.split(separator: "/").last.map { "#\($0)" } ?? "PR").font(Theme.sans(12))
        }
        .foregroundStyle(Theme.textSec)
        .padding(.horizontal, 7)
        .frame(height: 20)
        .background(Capsule().fill(Color.white.opacity(0.06)))
    }
}
