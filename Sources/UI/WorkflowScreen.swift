import SwiftUI

/// The Workflow Studio screen: which columns cards go through (optional ones turn off) and how many agents work at
/// once. Saving rewrites the workflow file and restarts the engine.
struct WorkflowScreen: View {
    @ObservedObject var model: AppModel
    @State private var off: Set<String> = []
    @State private var agents = 1
    @State private var toTriage = false
    @State private var toTodo = false
    @State private var more = false
    @State private var showEngine = false
    @State private var restarting = false
    /// Agents at once across every running workspace on this Mac (`SetupStore.agentCeiling`).
    @State private var ceiling = SetupStore.defaultCeiling

    private var saved: (off: Set<String>, agents: Int) { (Set(model.choices.stagesOff ?? []), max(1, model.choices.agentsAtOnce ?? 1)) }
    private var savedMoves: (triage: Bool, todo: Bool) { (model.choices.sendNewToTriage ?? false, model.choices.startReady ?? false) }
    private var savedCeiling: Int { model.store.agentCeiling ?? SetupStore.defaultCeiling }
    private var changes: Int {
        saved.off.symmetricDifference(off).count + (saved.agents == agents ? 0 : 1) + (savedMoves.triage == toTriage ? 0 : 1)
            + (savedMoves.todo == toTodo ? 0 : 1) + (savedCeiling == ceiling ? 0 : 1)
    }

    var body: some View {
        VStack(spacing: 0) {
            TopBar(suffix: "Workflow Studio") {
                Button("Settings") { model.go(AppModel.settingsScreen) }
                    .buttonStyle(ForgeButton(kind: .ghost, hint: "⌘,", icon: "gearshape"))
                    .keyboardShortcut(",", modifiers: .command)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    PageHeader(
                        eyebrow: "Forge · Workflow Studio", title: "Workflow Studio",
                        lead: "Which stages your cards go through. Turn off the ones you don't need.")
                    HStack(alignment: .top, spacing: 40) {
                        stageList.frame(maxWidth: .infinity)
                        sidePanel.frame(width: 320)
                    }
                }
                .padding(.horizontal, 40).padding(.top, 32).padding(.bottom, 40)
            }
            bar
        }
        .background(Atmosphere())
        .onAppear {
            off = saved.off
            agents = saved.agents
            more = agents > 4
            (toTriage, toTodo) = savedMoves
            ceiling = savedCeiling
            if model.preview, model.sample.scene == "qa-off" { off.insert("QA") }
            if model.preview, model.sample.scene == "restarting" { restarting = true }
            if model.preview, model.sample.scene == "moves-on" { (toTriage, toTodo) = (true, true) }
        }
    }

    // MARK: Stages

    private var stageList: some View {
        VStack(spacing: 0) {
            ForEach(Array(Pipeline.columns.enumerated()), id: \.offset) { i, c in
                let optional = Pipeline.optionalColumns.contains(c.name)
                let isOff = off.contains(c.name)
                HStack(spacing: 16) {
                    StageDot(stage: c.name).opacity(isOff ? 0.4 : 1)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(c.name).font(Theme.sans(15, .medium)).foregroundStyle(Theme.text).opacity(isOff ? 0.4 : 1)
                        Text(c.line).font(Theme.sans(13)).foregroundStyle(Theme.textSec).fixedSize(horizontal: false, vertical: true)
                            .opacity(isOff ? 0.4 : 1)
                        if isOff { Text(Pipeline.skipLine(c.name, off: Array(off))).font(Theme.mono(11)).foregroundStyle(Theme.textSec) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Chip(text: Pipeline.who(c.name), tone: .quiet).opacity(isOff ? 0.4 : 1).frame(width: 48, alignment: .leading)
                    HStack {
                        Spacer(minLength: 0)
                        if optional {
                            ForgeToggle(on: Binding(get: { !isOff }, set: { on in if on { off.remove(c.name) } else { off.insert(c.name) } }))
                        } else {
                            SectionLabel(text: "Always on")
                        }
                    }
                    .frame(width: 80)
                }
                .padding(.horizontal, 20).padding(.vertical, 16)
                .overlay(alignment: .top) { if i > 0 { Rectangle().fill(Theme.border).frame(height: 1) } }
            }
        }
        .panel()
        .clipShape(RoundedRectangle(cornerRadius: Theme.rLg))
    }

    // MARK: Agents at once, and what the engine sees

    private var sidePanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel(text: "Agents at once")
            Segmented(
                options: [(1, "1"), (2, "2"), (3, "3"), (4, "4"), (5, "+")],
                selection: Binding(
                    get: { more ? 5 : agents },
                    set: { v in
                        more = v == 5
                        agents = v == 5 ? max(agents, 5) : v
                    }),
                heat: true, mono: true)
            if more {
                HStack(spacing: 8) {
                    TextField("", value: $agents, format: .number).forgeField(mono: true).frame(width: 96)
                    Text("agents").font(Theme.sans(13)).foregroundStyle(Theme.textSec)
                }
            }
            Text("Each agent takes one card and may send its own helpers. This is for each project in \(model.workspace?.name ?? "this workspace").")
                .font(Theme.sans(11)).foregroundStyle(Theme.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            Rectangle().fill(Theme.border).frame(height: 1).padding(.vertical, 4)
            SectionLabel(text: "Across all workspaces")
            HStack(spacing: 8) {
                TextField("", value: $ceiling, format: .number).forgeField(mono: true).frame(width: 96)
                Text("agents at most").font(Theme.sans(13)).foregroundStyle(Theme.textSec)
            }
            Text("Running workspaces share this Mac and your accounts' usage limits. Cards wait until an agent is free.")
                .font(Theme.sans(11)).foregroundStyle(Theme.textMuted).fixedSize(horizontal: false, vertical: true)
            Rectangle().fill(Theme.border).frame(height: 1).padding(.vertical, 4)
            backlogMoves
            Rectangle().fill(Theme.border).frame(height: 1).padding(.vertical, 4)
            Button {
                withAnimation(.easeOut(duration: 0.2)) { showEngine.toggle() }
            } label: {
                HStack {
                    Text("What the engine sees").font(Theme.sans(11)).foregroundStyle(showEngine ? Theme.textSec : Theme.textMuted)
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).rotationEffect(.degrees(showEngine ? 90 : 0))
                        .foregroundStyle(Theme.textMuted)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if showEngine || model.sample.scene == "qa-off" {
                chips("active_states", Pipeline.activeColumns(off: Array(off)))
                chips("columns", Pipeline.names)
            }
        }
        .padding(20)
        .panel()
    }

    // MARK: Forge moves cards out of Backlog

    private var backlogMoves: some View {
        let triageOn = !off.contains("Triage")
        return VStack(alignment: .leading, spacing: 12) {
            SectionLabel(text: "Forge moves cards out of Backlog")
            moveRow(
                "New cards to Triage",
                triageOn
                    ? "Unassigned cards not marked ready go to Triage, two at a time, so an agent plans them."
                    : "Triage is off, so new cards stay in Backlog.",
                on: $toTriage, enabled: triageOn)
            moveRow("Ready cards to Todo", "Cards marked ready go to Todo, so an agent builds them.", on: $toTodo, enabled: true)
            Text("Forge checks Backlog every 5 minutes.").font(Theme.sans(11)).foregroundStyle(Theme.textMuted)
        }
    }

    private func moveRow(_ title: String, _ line: String, on: Binding<Bool>, enabled: Bool) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
                Text(line).font(Theme.sans(11)).foregroundStyle(Theme.textSec).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            ForgeToggle(on: enabled ? on : .constant(false)).opacity(enabled ? 1 : 0.4).allowsHitTesting(enabled)
        }
        .opacity(enabled ? 1 : 0.6)
    }

    private func chips(_ key: String, _ values: [String]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: key)
            FlowChips(values: values)
        }
    }

    // MARK: Bottom bar

    private var bar: some View {
        BottomBar {
            if restarting {
                HStack(spacing: 8) {
                    Spinner(heat: true)
                    Text(restartLine).foregroundStyle(Theme.textSec)
                }
            } else {
                HStack(spacing: 8) {
                    if changes > 0 {
                        Text("\(changes) change\(changes == 1 ? "" : "s") not saved").font(Theme.mono(11)).foregroundStyle(Theme.text)
                        Text("·")
                    }
                    Text("Saving restarts the engine. Running agents pause and pick their cards back up.")
                }
            }
        } actions: {
            Button("Back to Orchestrator") { model.go(AppModel.boardScreen) }
                .buttonStyle(ForgeButton(kind: .ghost, icon: "chevron.left", large: true))
                .disabled(restarting)
            Button("Save workflow", action: save)
                .buttonStyle(ForgeButton(kind: .primary, large: true))
                .disabled(changes == 0 || restarting)
        }
    }

    private var restartLine: String {
        let busy = model.engine?.running.map(\.issue_identifier) ?? (model.preview ? ["AIT-3"] : [])
        if busy.isEmpty { return "Restarting the engine…" }
        return "Restarting the engine… \(busy.count) agent\(busy.count == 1 ? " is" : "s are") wrapping up \(busy.joined(separator: ", ")) first."
    }

    private func save() {
        model.choices.stagesOff = Pipeline.optionalColumns.filter { off.contains($0) }
        model.choices.agentsAtOnce = max(1, agents)
        model.choices.sendNewToTriage = toTriage
        model.choices.startReady = toTodo
        let ceilingChanged = savedCeiling != max(1, ceiling)
        model.store.agentCeiling = max(1, ceiling) == SetupStore.defaultCeiling ? nil : max(1, ceiling)
        model.save()
        restarting = true
        Task {
            if !model.preview, let w = model.workspace?.id {
                // The ceiling is read by every engine when it starts: a new one restarts every running workspace.
                if ceilingChanged { for o in model.runningWorkspaces where o.id != w { await model.restartEngines(in: o.id, shown: false) } }
                await model.restartEngines(in: w)
            }
            restarting = false
            model.go(AppModel.boardScreen)
        }
    }
}

/// Mono chips that wrap onto as many lines as they need.
struct FlowChips: View {
    let values: [String]

    var body: some View {
        var rows: [[String]] = [[]]
        var width: CGFloat = 0
        for v in values {
            let w = CGFloat(v.count) * 6.6 + 24
            if width + w > 270, !rows[rows.count - 1].isEmpty {
                rows.append([])
                width = 0
            }
            rows[rows.count - 1].append(v)
            width += w
        }
        return VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 8) { ForEach(row, id: \.self) { Chip(text: $0) } }
            }
        }
    }
}
