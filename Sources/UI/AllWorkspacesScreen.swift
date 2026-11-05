import SwiftUI

/// "All workspaces": every running workspace's cards in one Orchestrator (design frame w1b). The same headline,
/// stats and tables as a workspace's own, with a Workspace column; a row opens that project. Stop stops every
/// running workspace.
struct AllWorkspacesScreen: View {
    @ObservedObject var model: AppModel
    @State private var busy = false

    private var fleet: [AppModel.Running] { model.fleet }
    private var merged: EngineState? { fleet.isEmpty ? nil : Self.merge(fleet.map(\.state)) }
    private var inFlight: Int { fleet.reduce(0) { $0 + $1.state.running.count } }

    var body: some View {
        VStack(spacing: 0) {
            TopBar(suffix: "Orchestrator") { navRight }
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    header
                    if fleet.isEmpty {
                        empty
                    } else {
                        StatsRow(state: merged)
                        runningTable
                        HStack(alignment: .top, spacing: 20) {
                            list("Your turn", stage: "Human Review", line: "Pull request ready to review")
                            list("Up next", stage: "Todo", line: "Waiting to start")
                        }
                    }
                }
                .padding(.horizontal, 32).padding(.top, 32).padding(.bottom, 24)
            }
        }
        .background(Atmosphere())
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    // MARK: Top bar

    private var navRight: some View {
        HStack(spacing: 12) {
            if !model.runningWorkspaces.isEmpty {
                Pill(
                    text: "\(inFlight) agent\(inFlight == 1 ? "" : "s")", tone: inFlight > 0 ? .heat : .neutral,
                    dot: inFlight > 0 ? Theme.heat : Theme.textMuted, pulsing: inFlight > 0)
            }
            UsageLine(state: merged)
            Button("Settings") { model.go(AppModel.settingsScreen) }
                .buttonStyle(ForgeButton(kind: .ghost, hint: "⌘,", icon: "gearshape"))
                .keyboardShortcut(",", modifiers: .command)
            if !model.runningWorkspaces.isEmpty {
                Button("Stop all") {
                    busy = true
                    Task {
                        for w in model.runningWorkspaces { await model.stop(workspace: w.id) }
                        busy = false
                    }
                }
                .buttonStyle(ForgeButton(kind: .secondary, hint: "⌘.", icon: "stop.fill"))
                .keyboardShortcut(".", modifiers: .command)
                .disabled(busy)
            }
        }
    }

    // MARK: Header

    private var header: some View {
        let n = model.runningWorkspaces.count
        return VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: "All workspaces · \(n) running")
            (Text("On the anvil — ").foregroundColor(Theme.text)
                + Text("\(inFlight) card\(inFlight == 1 ? "" : "s")\(inFlight > 0 ? " in flight" : "")")
                .foregroundColor(inFlight > 0 ? Theme.heat : Theme.textSec))
                .font(Theme.display(38)).padding(.top, 8)
            Text(n == 0 ? "No workspace is running." : "Everything your agents are working on, in every running workspace.")
                .font(Theme.sans(13)).foregroundStyle(Theme.textSec).padding(.top, 8)
        }
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Start a workspace from the list at the top, next to Forge.").font(Theme.sans(13)).foregroundStyle(Theme.textSec)
            Text("Running workspaces share this Mac and your intelligence provider accounts' usage limits.")
                .font(Theme.sans(12)).foregroundStyle(Theme.textMuted)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(Theme.wash1))
        .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.border))
    }

    // MARK: Running sessions

    private struct Row: Identifiable {
        var source: AppModel.Running
        var run: EngineState.RunningCard
        var id: String { source.project.id + "/" + run.issue_identifier }
    }

    private var rows: [Row] { fleet.flatMap { f in f.state.running.map { Row(source: f, run: $0) } } }

    private var runningTable: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel(text: "Running sessions")
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    head("Workspace").frame(width: 170, alignment: .leading)
                    head("Card").frame(minWidth: 260, maxWidth: .infinity, alignment: .leading)
                    head("Stage").frame(width: 128, alignment: .leading)
                    head("Role · provider").frame(width: 170, alignment: .leading)
                    head("What it's doing").frame(maxWidth: .infinity, alignment: .leading)
                    head("Elapsed").frame(width: 80, alignment: .leading)
                }
                .padding(.horizontal, 16).frame(height: 40)
                .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
                if rows.isEmpty {
                    Text("No agent is working right now.").font(Theme.sans(13)).foregroundStyle(Theme.textMuted)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                }
                ForEach(rows) { r in
                    runRow(r)
                    if r.id != rows.last?.id { Rectangle().fill(Theme.border).frame(height: 1) }
                }
            }
            .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(Theme.wash1))
            .clipShape(RoundedRectangle(cornerRadius: Theme.rMd))
            .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.border))
        }
    }

    private func runRow(_ r: Row) -> some View {
        let stage = r.run.state ?? ""
        return HStack(spacing: 12) {
            workspaceCell(r.source.workspace).frame(width: 170, alignment: .leading)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(r.run.issue_identifier).font(Theme.mono(11)).foregroundStyle(Theme.textMuted)
                Text(r.run.issue_title ?? "").font(Theme.sans(13, .medium)).foregroundStyle(Theme.text).lineLimit(1)
            }
            .frame(minWidth: 260, maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 0) { Pill(text: stage, stage: stage, dot: Theme.stage(stage).dot, pulsing: true) }
                .frame(width: 128, alignment: .leading)
            Text(model.roleLine(r.source.project, stage: stage)).font(Theme.sans(12)).foregroundStyle(Theme.textSec).lineLimit(1)
                .frame(width: 170, alignment: .leading)
            Text(r.run.activity ?? r.run.last_message ?? "Working").font(Theme.sans(13)).foregroundStyle(Theme.textSec).lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(Self.elapsed(r.run.started_at)).font(Theme.mono(11)).foregroundStyle(Theme.textSec).frame(width: 80, alignment: .leading)
        }
        .padding(.horizontal, 16).frame(minHeight: 52)
        .background(alignment: .leading) {
            LinearGradient(colors: [.clear, Theme.heat, .clear], startPoint: .top, endPoint: .bottom).frame(width: 2)
        }
        .contentShape(Rectangle())
        .onTapGesture { open(r.source) }
    }

    // MARK: Your turn, Up next

    private func list(_ title: String, stage: String, line: String) -> some View {
        let cards = fleet.flatMap { f in f.state.cards.filter { $0.state == stage }.map { (f, $0) } }
        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                SectionLabel(text: title)
                Spacer()
                Text(stage).font(Theme.sans(11)).foregroundStyle(Theme.textMuted)
            }
            VStack(spacing: 0) {
                if cards.isEmpty {
                    Text("Nothing here.").font(Theme.sans(13)).foregroundStyle(Theme.textMuted)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                }
                ForEach(Array(cards.enumerated()), id: \.offset) { i, pair in
                    let (f, c) = pair
                    HStack(alignment: .top, spacing: 12) {
                        WorkspaceTile(f.workspace, size: 24)
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(c.identifier).font(Theme.mono(11)).foregroundStyle(Theme.textMuted)
                                Text(c.title).font(Theme.sans(13, .medium)).foregroundStyle(Theme.text).lineLimit(1)
                            }
                            Text("\(f.workspace.name) · \(f.project.name) · \(line)").font(Theme.sans(12)).foregroundStyle(Theme.textSec).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(16)
                    .contentShape(Rectangle())
                    .onTapGesture { open(f) }
                    if i < cards.count - 1 { Rectangle().fill(Theme.border).frame(height: 1) }
                }
            }
            .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(Theme.wash1))
            .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.border))
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private func workspaceCell(_ w: Workspace) -> some View {
        HStack(spacing: 8) {
            WorkspaceTile(w, size: 24)
            Text(w.name).font(Theme.sans(13)).foregroundStyle(Theme.text).lineLimit(1)
        }
    }

    private func head(_ t: String) -> some View { SectionLabel(text: t) }

    private func open(_ f: AppModel.Running) {
        guard !model.preview else { return }
        Task {
            await model.open(workspace: f.workspace.id, project: f.project.id)
            model.go(AppModel.boardScreen)
        }
    }

    static func elapsed(_ iso: String?) -> String {
        guard let iso, let d = ISO8601DateFormatter.withFraction.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return "—" }
        let t = Int(max(0, Date().timeIntervalSince(d)))
        return t >= 3600 ? "\(t / 3600)h \(t % 3600 / 60)m" : "\(t / 60)m \(String(format: "%02d", t % 60))s"
    }

    /// Several engines' states as one: running if any runs, every agent and retry, usage added up, the board's
    /// columns joined by name, the longest runtime.
    static func merge(_ states: [EngineState]) -> EngineState {
        var m = EngineState(status: states.contains(where: \.isRunning) ? "running" : "stopped", running: [])
        m.started_at = states.compactMap(\.started_at).min()
        m.running = states.flatMap(\.running)
        m.retrying = states.flatMap { $0.retrying ?? [] }
        var columns: [EngineState.Column] = []
        for s in states {
            for c in s.board?.columns ?? [] {
                if let i = columns.firstIndex(where: { $0.name == c.name }) { columns[i].cards += c.cards } else { columns.append(c) }
            }
        }
        m.board = EngineState.Board(columns: columns, read_at: nil, problem: nil)
        func add(_ a: EngineState.Spend?, _ b: EngineState.Spend?) -> EngineState.Spend? {
            guard a != nil || b != nil else { return nil }
            return EngineState.Spend(
                runs: (a?.runs ?? 0) + (b?.runs ?? 0), inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
                outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0))
        }
        m.usage = EngineState.Usage(
            last_24h: states.map { $0.usage?.last_24h }.reduce(nil, add), all_time: states.map { $0.usage?.all_time }.reduce(nil, add))
        m.rate_limits = states.compactMap(\.rate_limits).first
        return m
    }
}
