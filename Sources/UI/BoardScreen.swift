import SwiftUI

/// The board: live columns from Linear, one plain line per card about what its agent is doing, the lead's
/// helpers, usage, Start and Stop, and each card's detail. Pushed by the engine; nothing is polled here.
struct BoardScreen: View {
    @ObservedObject var model: AppModel
    @ObservedObject private var updater = Updater.shared
    @State private var open: EngineState.Card?
    @State private var busy = false

    private var state: EngineState? { model.engine }
    private var problem: String? { model.engineProblem ?? state?.board?.problem }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            toolbar
            header
            if let problem { ProblemBanner(problem: problem, model: model).padding(.horizontal, 16).padding(.bottom, 12) }
            if let columns = state?.board?.columns {
                BoardColumns(columns: columns, paused: problem != nil, open: $open)
            } else {
                BoardColumns(columns: Pipeline.names.map { .init(name: $0, cards: []) }, paused: false, loading: true, open: $open)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .task {
            let restart = model.settingsChanged
            model.settingsChanged = false
            await model.link.connect(restart: restart)
            // `open -a Forge --args --start`: press Start once the board is up (the same call the button makes).
            if CommandLine.arguments.contains("--start"), state?.isRunning == false { await model.link.start() }
        }
        .sheet(item: $open) { card in
            CardDetail(model: model, card: state?.cards.first { $0.id == card.id } ?? card) { open = nil }
        }
    }

    /// The title bar row: the window's name, usage, and the board's buttons.
    private var toolbar: some View {
        HStack(spacing: 8) {
            Text(AppInfo.name).font(Theme.sans(13, .medium)).foregroundStyle(Theme.textSec).padding(.leading, 104)
            Spacer()
            UsageView(state: state).padding(.trailing, 8)
            if let rel = updater.available, !model.preview {
                Button(updater.installing ? "Updating…" : "Update to \(rel.version)") { Task { await updater.install() } }
                    .buttonStyle(ForgeButton(kind: .secondary, icon: "arrow.down.circle"))
                    .disabled(updater.installing)
                    .help(updater.problem ?? "Agents finish what they're doing, then Forge restarts on the new version.")
            }
            Button("Workflow") { model.go(0) }
                .buttonStyle(ForgeButton(kind: .secondary, hint: "⌘,", icon: "slider.horizontal.3"))
                .keyboardShortcut(",", modifiers: .command)
            if state?.isRunning == true {
                Button("Stop") { act { await model.link.stop() } }
                    .buttonStyle(ForgeButton(kind: .secondary, hint: "⌘.", icon: "stop.fill"))
                    .keyboardShortcut(".", modifiers: .command)
                    .disabled(busy || state?.status == "stopping")
            } else {
                Button("Start") { act { await model.link.start() } }
                    .buttonStyle(ForgeButton(kind: .primary, hint: "↵", icon: "play.fill"))
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || state == nil)
            }
        }
        .padding(.trailing, 16)
        .frame(height: TitleBarSpace.height)
    }

    private var header: some View {
        HStack(spacing: 14) {
            AnvilMark().sized(34)
            Text(model.choices.projectName ?? "Board").font(Theme.display(26)).foregroundStyle(Theme.text).lineLimit(1)
            StatusPill(text: status.text, live: status.live, busy: status.busy)
            Spacer()
        }
        .padding(.horizontal, 24)
        .padding(.top, 4)
        .padding(.bottom, 16)
    }

    private var status: (text: String, live: Bool, busy: Bool) {
        guard let s = state else { return (model.engineProblem == nil ? "Reading your board…" : "Starting Forge…", false, true) }
        let working = s.running.count
        switch s.status {
        case "running":
            return working == 0 ? ("Watching for cards in Todo", false, false) : ("\(working) agent\(working == 1 ? "" : "s") working", true, false)
        case "stopping": return ("Stopping: agents finish what they're doing first", false, true)
        default: return ("Stopped. Press Start to let agents take cards.", false, false)
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

/// A problem the board can't get past: the plain line, then the one button that fixes its cause (when
/// Forge knows one), and a note that the board picks up again by itself.
struct ProblemBanner: View {
    let problem: String
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "exclamationmark.triangle").font(.system(size: 13, weight: .medium))
                Text(problem).font(Theme.sans(14, .medium)).fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(Theme.heatBright)
            HStack(spacing: 14) {
                if let fix = Self.fix(for: problem) {
                    Button(fix.title) { fix.isLink ? model.openLink(fix.target) : model.go(0) }
                        .buttonStyle(ForgeButton(kind: .fix, icon: fix.isLink ? "arrow.up.right.square" : nil))
                }
                Text("Forge tries again by itself.").font(Theme.sans(12)).foregroundStyle(Theme.textMuted)
            }
            .padding(.leading, 21)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.heat.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.heat.opacity(0.22)))
    }

    /// The one fix for the problems Forge recognizes; nil when there's nothing to press.
    static func fix(for problem: String) -> (title: String, target: String, isLink: Bool)? {
        let p = problem.lowercased()
        if p.contains("didn't accept this key") { return ("Change the Linear key", "", false) }
        if p.contains("linear said") && (p.contains("usage limit") || p.contains("plan")) {
            return ("Open your Linear plan", "https://linear.app/settings/billing", true)
        }
        return nil
    }
}

/// Usage: a Claude plan's 5-hour and weekly windows as small meters, else tokens today.
struct UsageView: View {
    let state: EngineState?

    var body: some View {
        if let limits = state?.rate_limits, !limits.isEmpty {
            HStack(spacing: 12) {
                ForEach(Array(limits.keys.sorted().enumerated()), id: \.element) { i, k in
                    if i > 0 { Rectangle().fill(Theme.hairline).frame(width: 1, height: 14) }
                    meter(Self.windowName(k), limits[k]?.percent)
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 28)
            .background(RoundedRectangle(cornerRadius: 6).fill(Theme.surface.opacity(0.6)))
        } else if let day = state?.usage?.last_24h {
            Text("Today \(Self.short((day.inputTokens ?? 0) + (day.outputTokens ?? 0))) tokens")
                .font(Theme.sans(12)).foregroundStyle(Theme.textSec)
                .padding(.horizontal, 12)
                .frame(height: 28)
                .background(RoundedRectangle(cornerRadius: 6).fill(Theme.surface.opacity(0.6)))
        }
    }

    private func meter(_ label: String, _ percent: Int?) -> some View {
        HStack(spacing: 8) {
            Text(label).font(Theme.sans(12)).foregroundStyle(Theme.textSec)
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.1))
                Capsule().fill(Theme.text).frame(width: 32 * CGFloat(min(max(percent ?? 0, 0), 100)) / 100)
            }
            .frame(width: 32, height: 4)
            Text(percent.map { "\($0)%" } ?? "in use").font(Theme.mono(11)).foregroundStyle(Theme.text)
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
}
