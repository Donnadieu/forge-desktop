import SwiftUI

/// The Workflow Studio screen: which columns cards go through (optional ones turn off), who works each stage (its
/// role's provider, account and model), and how many agents work at once. Saving rewrites the workflow file and
/// restarts the engine.
struct WorkflowScreen: View {
    @ObservedObject var model: AppModel
    @State private var off: Set<String> = []
    @State private var agents = 1
    @State private var toTriage = false
    @State private var toTodo = false
    @State private var more = false
    @State private var restarting = false
    /// What others see (WhatOthersSee.swift).
    @State private var invisible = false
    @State private var label = "forge"
    @State private var prefix = ""
    /// Agents at once across every running workspace on this Mac (`SetupStore.agentCeiling`).
    @State private var ceiling = SetupStore.defaultCeiling
    /// Stages with their own provider, account and model (`SetupChoices.roles`, per project).
    @State private var roles: [RoleChoice] = []

    private var saved: (off: Set<String>, agents: Int) { (Set(model.choices.stagesOff ?? []), max(1, model.choices.agentsAtOnce ?? 1)) }
    private var savedMoves: (triage: Bool, todo: Bool) { (model.choices.sendNewToTriage ?? false, model.choices.startReady ?? false) }
    private var savedCeiling: Int { model.store.agentCeiling ?? SetupStore.defaultCeiling }
    private var savedMarks: (invisible: Bool, label: String, prefix: String) {
        let on = model.choices.invisible ?? false
        return (on, model.choices.prLabel ?? (on ? "" : "forge"), model.choices.branchPrefix ?? "")
    }
    private var changes: Int {
        saved.off.symmetricDifference(off).count + (saved.agents == agents ? 0 : 1) + (savedMoves.triage == toTriage ? 0 : 1)
            + (savedMoves.todo == toTodo ? 0 : 1) + (savedCeiling == ceiling ? 0 : 1) + roleChanges
            + (savedMarks.invisible == invisible ? 0 : 1) + (savedMarks.label == label ? 0 : 1) + (savedMarks.prefix == prefix ? 0 : 1)
    }

    private var roleChanges: Int {
        StageRole.changes(model.choices.roles ?? [], roles)
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
                        lead: "Which stages your cards go through, and who works each one. Turn off the ones you don't need.")
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
            roles = model.choices.roles ?? []
            (invisible, label, prefix) = savedMarks
            if model.preview, model.sample.scene == "invisible" { (invisible, label, prefix) = (true, "", "omar/") }
            if model.preview, model.sample.scene == "roles" {
                roles = [
                    RoleChoice(role: .builds, accountID: "sample-codex"),
                    RoleChoice(role: .reviews, accountID: "sample-work", model: "claude-opus-5"),
                ]
            }
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
                let missing = model.choices.unavailableStages.contains(c.name)
                let isOff = off.contains(c.name) || missing
                HStack(spacing: 16) {
                    StageDot(stage: c.name).opacity(isOff ? 0.4 : 1)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(c.name).font(Theme.sans(15, .medium)).foregroundStyle(Theme.text).opacity(isOff ? 0.4 : 1)
                        Text(c.line).font(Theme.sans(13)).foregroundStyle(Theme.textSec).fixedSize(horizontal: false, vertical: true)
                            .opacity(isOff ? 0.4 : 1)
                        if case .unavailable(let why) = model.choices.stageState(c.name) {
                            Text(why).font(Theme.mono(11)).foregroundStyle(Theme.textSec)
                        } else if isOff {
                            Text(Pipeline.skipLine(c.name, off: Array(off.union(model.choices.unavailableStages))))
                                .font(Theme.mono(11)).foregroundStyle(Theme.textSec)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    worker(c.name).opacity(isOff ? 0.4 : 1).disabled(isOff).frame(width: 290, alignment: .leading)
                    HStack {
                        Spacer(minLength: 0)
                        if missing {
                            // Can't be switched on until the board has the column.
                            ForgeToggle(on: .constant(false)).opacity(0.4).allowsHitTesting(false)
                                .help("Add a \(c.name) column to \(model.choices.boardName) to use this stage.")
                        } else if optional {
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

    /// Who works this stage, on its own row.
    @ViewBuilder private func worker(_ stage: String) -> some View {
        switch StageRole.cell(stage) {
        case .picker(let r): StageWorkerPicker(model: model, roles: $roles, role: r)
        case .follows(let first): Text("Same as \(first)").font(Theme.sans(12)).foregroundStyle(Theme.textMuted)
        case .usesDefault: Text("Default provider").font(Theme.sans(12)).foregroundStyle(Theme.textMuted)
        case .you: Chip(text: "you", tone: .quiet)
        case .none: EmptyView()
        }
    }

    // MARK: Agents at once, and what the engine sees

    private var sidePanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel(text: "Default provider")
            HStack(alignment: .top) {
                DefaultProviderLine(model: model)
                Spacer()
                Button("Change", action: changeDefault).buttonStyle(ForgeButton(kind: .ghost, icon: "arrow.up.right"))
                    .disabled(restarting)
            }
            Text(
                "Works every stage of \(model.choices.projectName ?? "this project") that has no provider of its own. Accounts are added in Settings."
            )
            .font(Theme.sans(11)).foregroundStyle(Theme.textMuted).fixedSize(horizontal: false, vertical: true)
            Rectangle().fill(Theme.border).frame(height: 1).padding(.vertical, 4)
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
            whatOthersSee
            Rectangle().fill(Theme.border).frame(height: 1).padding(.vertical, 4)
            backlogMoves
            Rectangle().fill(Theme.border).frame(height: 1).padding(.vertical, 4)
            Button {
                model.go(AppModel.workflowFileScreen)
            } label: {
                HStack {
                    Text("Edit workflow file").font(Theme.sans(11)).foregroundStyle(Theme.textSec)
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.textMuted)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(restarting || changes > 0)
            .help(changes > 0 ? "Save or undo the changes here first." : "The file the engine reads, to edit by hand.")
        }
        .padding(20)
        .panel()
    }

    private var whatOthersSee: some View {
        let sample: (card: String, branch: String) =
            switch model.choices.board {
            case .basecamp: ("BC-10471774790", "basecamp/bc-10471774790")
            case .github: ("app#12", "github/app-12")
            case .linear: ("ENG-12", "Linear's own branch name")
            }
        return WhatOthersSee(invisible: $invisible, label: $label, prefix: $prefix, sampleCard: sample.card, trackerBranch: sample.branch)
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

    /// Setup 5 (the default provider), coming back here on Continue.
    private func changeDefault() {
        model.change(4)
        model.returnTo = AppModel.workflowScreen
    }

    private func save() {
        model.choices.stagesOff = Pipeline.optionalColumns.filter { off.contains($0) }
        model.choices.agentsAtOnce = max(1, agents)
        model.choices.sendNewToTriage = toTriage
        model.choices.startReady = toTodo
        // A role whose account was cleared meanwhile is dropped.
        model.choices.roles = model.choices.keptRoles(roles, store: model.store)
        let on = invisible
        let cleanLabel = label.trimmingCharacters(in: .whitespaces)
        model.choices.invisible = on ? true : nil
        model.choices.prLabel = cleanLabel == (on ? "" : "forge") ? nil : cleanLabel
        model.choices.branchPrefix = prefix.isEmpty ? nil : prefix
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
