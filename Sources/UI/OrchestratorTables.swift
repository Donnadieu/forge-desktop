import SwiftUI

/// The Orchestrator's four stats (`.stat`): Running, Retrying, Tokens today, Runtime. Only numbers that
/// appear nowhere else on the page.
struct StatsRow: View {
    let state: EngineState?

    var body: some View {
        HStack(spacing: 12) {
            stat(value: state.map { "\($0.running.count)" }, label: "Running", note: runningNote, heat: (state?.running.count ?? 0) > 0)
            stat(value: state.map { "\($0.retrying?.count ?? 0)" }, label: "Retrying", note: retryNote)
            stat(value: state.map { _ in UsageLine.short(tokens) }, label: "Tokens today", note: tokenNote)
            stat(value: state.map { _ in runtime }, label: "Runtime", note: runtimeNote)
        }
    }

    private func stat(value: String?, label: String, note: String, heat: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let value {
                Text(value).font(Theme.display(40)).foregroundStyle(heat ? Theme.heat : Theme.text).monospacedDigit()
            } else {
                RoundedRectangle(cornerRadius: Theme.rSm).fill(Theme.wash2).frame(width: 64, height: 32).padding(.vertical, 4)
            }
            SectionLabel(text: label)
            Text(note).font(Theme.mono(10.5)).tracking(0.4).foregroundStyle(Theme.textMuted).lineLimit(1)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(Theme.wash1))
        .background(alignment: .bottomTrailing) {
            if heat {
                Circle().fill(RadialGradient(colors: [Theme.heatGlow, .clear], center: .center, startRadius: 0, endRadius: 40)).frame(
                    width: 80, height: 80
                ).offset(x: 32, y: 32)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: Theme.rMd))
        .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.border))
    }

    private var waiting: Int {
        let busy = Set(state?.running.map(\.issue_identifier) ?? [])
        return OrchestratorTables.inFlightCards(state).filter { !busy.contains($0.identifier) }.count
    }
    private var runningNote: String {
        guard let s = state else { return "reading…" }
        if s.status == "stopping" { return "finishing up" }
        if !s.isRunning { return "stopped" }
        return waiting > 0 ? "\(waiting) more waiting for an agent" : "nothing waiting"
    }
    private var retryNote: String {
        let n = state?.retrying?.count ?? 0
        return n == 0 ? "retry queue empty" : "\(n) waiting to try again"
    }
    private var tokens: Int { (state?.usage?.last_24h?.inputTokens ?? 0) + (state?.usage?.last_24h?.outputTokens ?? 0) }
    private var tokenNote: String {
        let runs = state?.usage?.last_24h?.runs ?? 0
        return runs == 0 ? "no runs today" : "across \(runs) run\(runs == 1 ? "" : "s")"
    }
    private var started: Date? {
        guard let s = state?.started_at, state?.isRunning == true else { return nil }
        return ISO8601DateFormatter.withFraction.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }
    private var runtime: String { started.map { Self.duration(Date().timeIntervalSince($0)) } ?? "0m" }
    private var runtimeNote: String {
        guard let d = started else { return "stopped" }
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return "since Start at \(f.string(from: d))"
    }

    static func duration(_ seconds: TimeInterval) -> String {
        let m = Int(seconds / 60)
        return m >= 60 ? "\(m / 60)h \(m % 60)m" : "\(m)m"
    }
}

/// The Orchestrator's tables (`.tsec`, `.tbl`): Running sessions (each row opens to the agent's live lines),
/// Your turn, Up next and Later. When the board has no cards at all, one calm empty block instead.
struct OrchestratorTables: View {
    @ObservedObject var model: AppModel
    let state: EngineState?
    @Binding var open: EngineState.Card?
    /// A bulk move waiting for the person's yes (the screen shows the confirm sheet).
    @Binding var confirm: BulkMove?
    @State private var expanded: Set<String> = []

    /// Columns where a card is (or waits to be) in an agent's hands.
    static let flight = ["In Progress", "AI Review", "QA", "Rework", "Merging"]

    static func inFlightCards(_ state: EngineState?) -> [EngineState.Card] {
        let busy = Set(state?.running.map(\.issue_identifier) ?? [])
        return (state?.cards ?? []).filter { flight.contains($0.state) || busy.contains($0.identifier) }
    }

    private func cards(_ columns: [String]) -> [EngineState.Card] { (state?.cards ?? []).filter { columns.contains($0.state) } }

    var body: some View {
        if state == nil {
            section("Running sessions", count: nil) { skeleton }
        } else if state?.cards.isEmpty == true {
            EmptyBoard(project: model.choices.projectName ?? "your project", tracker: model.choices.board.name) {
                model.openLink(model.projectURL)
            }
        } else {
            VStack(alignment: .leading, spacing: 24) {
                let flying = Self.inFlightCards(state)
                section("Running sessions", count: flying.count) {
                    if flying.isEmpty { empty("No agent is working on a card") } else { runningTable(flying) }
                }
                let yours = cards(["Human Review"])
                let mergeAll = mergeOn && CardMoves.showsBulk(yours) ? ("Merge all", { confirm = BulkMove(kind: .merge, cards: yours) }) : nil
                section("Your turn", count: yours.count, stage: "Human Review", bulk: mergeAll) {
                    if yours.isEmpty { empty("Nothing in Human Review") } else { ForEach(yours) { yourTurnRow($0) } }
                }
                HStack(alignment: .top, spacing: 16) {
                    let next = cards(["Todo", "Triage"])
                    section("Up next", count: next.count) {
                        if next.isEmpty { empty("No cards waiting") } else { ForEach(next) { listRow($0) } }
                    }
                    let later = cards(["Backlog"])
                    let ready = later.filter(CardMoves.isReady)
                    let startAll = CardMoves.showsBulk(ready) ? ("Start all ready", { confirm = BulkMove(kind: .start, cards: ready) }) : nil
                    section("Later", count: later.count, bulk: startAll) {
                        if later.isEmpty { empty("Nothing in Backlog") } else { ForEach(later) { listRow($0) } }
                    }
                }
            }
        }
    }

    // MARK: Sections

    private func section<C: View>(
        _ title: String, count: Int?, stage: String? = nil, bulk: (String, () -> Void)? = nil, @ViewBuilder rows: () -> C
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                Text(title.uppercased()).font(Theme.mono(11)).tracking(1.5).foregroundStyle(Theme.textSec)
                if let count { Text("(\(count))").font(Theme.mono(11)).foregroundStyle(Theme.textMuted) }
                Spacer()
                if let bulk {
                    Button(bulk.0, action: bulk.1).buttonStyle(ForgeButton(kind: .secondary)).lineLimit(1).fixedSize()
                }
                if let stage {
                    HStack(spacing: 4) {
                        StageDot(stage: stage)
                        Text(stage)
                    }
                    .font(Theme.sans(11)).foregroundStyle(Theme.textMuted)
                }
            }
            // Same height with or without a bulk button, so side-by-side sections line up.
            .frame(minHeight: 32)
            VStack(spacing: 0) { rows() }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(Theme.wash1))
                .clipShape(RoundedRectangle(cornerRadius: Theme.rMd))
                .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.border))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func empty(_ text: String) -> some View {
        Text(text).font(Theme.serifItalic(14)).foregroundStyle(Theme.textMuted).frame(maxWidth: .infinity).padding(.vertical, 24)
    }

    private var skeleton: some View {
        ForEach(0..<3, id: \.self) { i in
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: Theme.rSm).fill(Theme.wash2).frame(width: 240, height: 12)
                RoundedRectangle(cornerRadius: Theme.rSm).fill(Theme.wash2).frame(width: 96, height: 12)
                Spacer()
            }
            .padding(.horizontal, 16).frame(height: 52)
            .overlay(alignment: .top) { if i > 0 { Rectangle().fill(Theme.border).frame(height: 1) } }
        }
    }

    // MARK: Running sessions

    private func runningTable(_ cards: [EngineState.Card]) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Color.clear.frame(width: 24)
                head("Card").frame(minWidth: 320, maxWidth: .infinity, alignment: .leading)
                head("Stage").frame(width: 128, alignment: .leading)
                head("Turns").frame(width: 56, alignment: .leading)
                head("What it's doing").frame(maxWidth: .infinity, alignment: .leading)
                head("Helpers").frame(width: 96, alignment: .leading)
                head("Elapsed").frame(width: 80, alignment: .leading)
                head("Attempt").frame(width: 64, alignment: .leading)
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(Theme.wash1)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
            ForEach(Array(cards.enumerated()), id: \.element.id) { i, c in
                RunningRow(card: c, run: state?.running.first { $0.issue_identifier == c.identifier }, expanded: expandedBinding(c.id)) {
                    open = c
                }
                .overlay(alignment: .top) { if i > 0 { Rectangle().fill(Theme.border).frame(height: 1) } }
            }
        }
    }

    private func head(_ t: String) -> some View { SectionLabel(text: t) }

    private func expandedBinding(_ id: String) -> Binding<Bool> {
        Binding(
            get: { expanded.contains(id) || (model.preview && id == "c3") }, set: { on in if on { expanded.insert(id) } else { expanded.remove(id) } }
        )
    }

    // MARK: Your turn, Up next, Later

    private func yourTurnRow(_ c: EngineState.Card) -> some View {
        HStack(spacing: 12) {
            cardCell(c).frame(maxWidth: .infinity, alignment: .leading)
            Text(c.prUrl.flatMap { $0.split(separator: "/").last.map { "#\($0)" } } ?? "—").font(Theme.mono(11)).foregroundStyle(Theme.textSec)
                .frame(width: 72, alignment: .leading)
            Text(
                mergeOn
                    ? "Look at the pull request, then merge it or ask for changes."
                    : "Look at the pull request, then merge it yourself or ask for changes."
            )
            .font(Theme.sans(13)).foregroundStyle(Theme.textSec)
            .lineLimit(2).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
            if let pr = c.prUrl {
                Button("Open pull request ↗") { model.openLink(pr) }.buttonStyle(ForgeButton(kind: .ghost)).lineLimit(1).fixedSize()
            }
            Button("Ask for changes") { move([c], to: "Rework") }.buttonStyle(ForgeButton(kind: .secondary)).lineLimit(1).fixedSize()
            if mergeOn {
                Button("Merge") { move([c], to: "Merging") }.buttonStyle(ForgeButton(kind: .primary)).lineLimit(1).fixedSize()
            }
        }
        .padding(.horizontal, 16).frame(minHeight: 52)
        .contentShape(Rectangle()).onTapGesture { open = c }
    }

    private func listRow(_ c: EngineState.Card) -> some View {
        let ready = c.state == "Backlog" && CardMoves.isReady(c)
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                cardCell(c)
                if c.state == "Todo", let waiting = CardMoves.waitingLine(c) {
                    Text(waiting).font(Theme.mono(11)).foregroundStyle(Theme.textMuted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if ready {
                Pill(text: "Ready", stage: "Todo")
                Button("Start") { move([c], to: "Todo") }.buttonStyle(ForgeButton(kind: .secondary)).lineLimit(1).fixedSize()
            } else {
                Pill(text: c.state, stage: c.state)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 8).frame(minHeight: 48)
        .background(ready ? Theme.wash2 : Color.clear)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1).opacity(0.6) }
        .contentShape(Rectangle()).onTapGesture { open = c }
    }

    /// Merging is on unless Workflow Studio turned it off (then the person merges on GitHub).
    private var mergeOn: Bool { model.choices.stageOn("Merging") }

    private func move(_ cards: [EngineState.Card], to: String) { Task { await model.link.move(cards, to: to) } }

    private func cardCell(_ c: EngineState.Card) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(c.identifier).font(Theme.mono(11)).foregroundStyle(Theme.textMuted)
            Text(c.title).font(Theme.sans(13, .medium)).foregroundStyle(Theme.text).lineLimit(1)
        }
    }
}

/// When the board has no cards: the anvil, one line of what to do next, and the one button for it.
struct EmptyBoard: View {
    let project: String
    /// Where the cards live: Linear or Basecamp.
    var tracker = "Linear"
    let openLinear: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            AnvilMark().sized(48, Theme.textMuted)
            Text("Nothing on the anvil yet").font(Theme.serifItalic(24)).foregroundStyle(Theme.textSec)
            Text("Add a card to Todo in \(tracker), then press Start.").font(Theme.sans(13)).foregroundStyle(Theme.textSec)
            Button("Open \(project) in \(tracker) ↗", action: openLinear)
                .buttonStyle(ForgeButton(kind: .primary, large: true))
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, minHeight: 320)
        .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(Theme.wash1))
        .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.border))
    }
}
