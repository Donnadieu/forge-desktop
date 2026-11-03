import SwiftUI

/// The board: live columns from Linear, one plain line per card about what its agent is doing, the lead's
/// helpers, usage, Start and Stop, and each card's detail. Pushed by the engine; nothing is polled here.
struct BoardScreen: View {
    @ObservedObject var model: AppModel
    @ObservedObject private var updater = Updater.shared
    @State private var open: EngineState.Card?
    @State private var busy = false

    private var state: EngineState? { model.engine }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if let problem = model.engineProblem ?? state?.board?.problem {
                ProblemLine(text: problem).padding(.horizontal, 20).padding(.bottom, 8)
            }
            if let columns = state?.board?.columns {
                ScrollView(.horizontal) {
                    HStack(alignment: .top, spacing: 12) {
                        ForEach(columns) { ColumnView(column: $0, open: $open) }
                    }
                    .padding(16)
                }
            } else {
                Spacer()
                ProgressView(model.engineProblem == nil ? "Reading your board…" : "")
                Spacer()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .task {
            let restart = model.settingsChanged
            model.settingsChanged = false
            await model.link.connect(restart: restart)
        }
        .sheet(item: $open) { card in
            CardDetail(model: model, card: state?.cards.first { $0.id == card.id } ?? card) { open = nil }
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                Text(model.choices.projectName ?? "Board").font(.system(size: 17, weight: .semibold))
                Text(statusLine).font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Spacer()
            UsageView(state: state)
            if let rel = updater.available, !model.preview {
                Button(updater.installing ? "Updating…" : "Update to \(rel.version)") { Task { await updater.install() } }
                    .disabled(updater.installing)
                    .help(updater.problem ?? "Agents finish what they're doing, then Forge restarts on the new version.")
            }
            Button("Workflow") { model.go(0) }
            if state?.isRunning == true {
                Button("Stop") { act { await model.link.stop() } }.disabled(busy)
            } else {
                Button("Start") { act { await model.link.start() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || state == nil)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    private var statusLine: String {
        guard let s = state else { return "Starting Forge…" }
        let working = s.running.count
        switch s.status {
        case "running":
            return working == 0 ? "Watching for cards in Todo" : "\(working) agent\(working == 1 ? "" : "s") working"
        case "stopping": return "Stopping: agents finish what they're doing first"
        default: return "Stopped. Press Start to let agents take cards."
        }
    }

    private func act(_ f: @escaping () async -> Void) {
        busy = true
        Task {
            await f()
            busy = false
        }
    }
}

/// Usage: a Claude plan's 5-hour and weekly windows when the agent reports them, else tokens today.
struct UsageView: View {
    let state: EngineState?

    var body: some View {
        HStack(spacing: 10) {
            if let limits = state?.rate_limits, !limits.isEmpty {
                ForEach(limits.keys.sorted(), id: \.self) { k in
                    pill(Self.windowName(k), limits[k]?.percent.map { "\($0)%" } ?? "in use")
                }
            } else if let day = state?.usage?.last_24h {
                pill("Today", "\(Self.short((day.inputTokens ?? 0) + (day.outputTokens ?? 0))) tokens")
            }
        }
    }

    static func windowName(_ k: String) -> String {
        switch k {
        case "five_hour": return "5 hours"
        case "seven_day": return "Week"
        case "seven_day_opus": return "Week (Opus)"
        case "seven_day_sonnet": return "Week (Sonnet)"
        default: return k.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    static func short(_ n: Int) -> String {
        n >= 1_000_000 ? String(format: "%.1fM", Double(n) / 1e6) : n >= 1000 ? "\(n / 1000)k" : "\(n)"
    }

    private func pill(_ label: String, _ value: String) -> some View {
        HStack(spacing: 4) {
            Text(label).foregroundStyle(.secondary)
            Text(value).fontWeight(.semibold)
        }
        .font(.system(size: 12))
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Capsule().fill(Color.secondary.opacity(0.12)))
    }
}

struct ColumnView: View {
    let column: EngineState.Column
    @Binding var open: EngineState.Card?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(column.name).font(.system(size: 13, weight: .semibold))
                Text("\(column.cards.count)").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 4)
            ForEach(column.cards) { card in
                CardView(card: card).onTapGesture { open = card }
            }
        }
        .frame(width: 210, alignment: .topLeading)
    }
}

struct CardView: View {
    let card: EngineState.Card

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(card.identifier).font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
                if card.prUrl != nil { Image(systemName: "arrow.triangle.pull").font(.system(size: 11)).foregroundStyle(.secondary) }
            }
            Text(card.title).font(.system(size: 13, weight: .medium)).lineLimit(3)
            if let line = card.activity {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Circle().fill(Color.green).frame(width: 7, height: 7)
                    Text(line).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            let working = card.helpers.filter(\.running)
            if !working.isEmpty {
                Text("\(working.count) helper\(working.count == 1 ? "" : "s"): \(working.map(\.description).joined(separator: ", "))")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(card.agent != nil ? Color.green.opacity(0.5) : Color.secondary.opacity(0.15)))
        .contentShape(Rectangle())
    }
}
