import SwiftUI

/// One row of Running sessions: the card, its stage, turns, what its agent is doing, helpers, time and
/// attempt. The chevron opens the agent's last lines as they stream in, newest at the bottom.
struct RunningRow: View {
    let card: EngineState.Card
    let run: EngineState.RunningCard?
    @Binding var expanded: Bool
    let open: () -> Void

    private var live: Bool { run != nil }
    private var lines: [EngineState.Line] { Array((run?.recent ?? card.recent ?? []).suffix(6)) }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button {
                    withAnimation(.easeOut(duration: 0.2)) { expanded.toggle() }
                } label: {
                    Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .foregroundStyle(expanded ? Theme.text : Theme.textMuted)
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(lines.isEmpty)
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(card.identifier).font(Theme.mono(11)).foregroundStyle(Theme.textMuted)
                    Text(card.title).font(Theme.sans(13, .medium)).foregroundStyle(Theme.text).lineLimit(1)
                }
                .frame(minWidth: 320, maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 0) { Pill(text: card.state, stage: card.state, dot: live ? Theme.stage(card.state).dot : nil, pulsing: live) }
                    .frame(width: 128, alignment: .leading)
                Text(run?.turn_count.map(String.init) ?? "—").font(Theme.mono(11, .medium)).foregroundStyle(Theme.text)
                    .frame(width: 56, alignment: .leading)
                Text(doing).font(Theme.sans(13)).foregroundStyle(Theme.textSec).lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(helpers).font(Theme.mono(11)).foregroundStyle(Theme.textSec).frame(width: 96, alignment: .leading)
                Text(elapsed).font(Theme.mono(11)).foregroundStyle(Theme.textSec).frame(width: 80, alignment: .leading)
                Text(run?.attempt.map(String.init) ?? card.agent.map { "\($0.attempt)" } ?? "—").font(Theme.mono(11)).foregroundStyle(Theme.textSec)
                    .frame(width: 64, alignment: .leading)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 52)
            .background(alignment: .leading) {
                if live {
                    LinearGradient(colors: [.clear, Theme.heat, .clear], startPoint: .top, endPoint: .bottom).frame(width: 2)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: open)
            if expanded && !lines.isEmpty { liveLines }
        }
    }

    private var liveLines: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(lines.enumerated()), id: \.offset) { i, l in
                let now = i == lines.count - 1 && live
                HStack(spacing: 12) {
                    Text(now ? "now" : Self.time(l.at)).foregroundStyle(now ? Theme.heat : Theme.textMuted).frame(width: 64, alignment: .leading)
                    Text(l.line).foregroundStyle(now ? Theme.text : (i >= lines.count - 3 ? Theme.textSec : Theme.textMuted)).lineLimit(1)
                    if now { Rectangle().fill(Theme.text).frame(width: 1, height: 14) }
                }
                .font(Theme.mono(11))
            }
        }
        .padding(.top, 12).padding(.bottom, 16).padding(.trailing, 16)
        .padding(.leading, 16 + 24 + 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.wash1)
        .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
    }

    private var doing: String {
        if let a = run?.activity ?? card.activity, live { return a }
        return "Waiting for a free agent"
    }

    private var helpers: String {
        guard live else { return "—" }
        let h = run?.helpers ?? card.helpers
        let n = h.filter(\.running).count
        return n > 0 ? "\(n) running" : "None"
    }

    private var elapsed: String {
        guard let s = run?.started_at ?? card.agent?.started_at, live,
            let d = ISO8601DateFormatter.withFraction.date(from: s) ?? ISO8601DateFormatter().date(from: s)
        else { return "—" }
        let t = Int(max(0, Date().timeIntervalSince(d)))
        return t >= 3600 ? "\(t / 3600)h \(t % 3600 / 60)m" : "\(t / 60)m \(String(format: "%02d", t % 60))s"
    }

    static func time(_ iso: String) -> String {
        guard let d = ISO8601DateFormatter.withFraction.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return "" }
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f.string(from: d)
    }
}
