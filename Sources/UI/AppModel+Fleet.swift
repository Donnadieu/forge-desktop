import SwiftUI

/// Everything running at once: one engine per project, Start and Stop per workspace, and one ceiling on agents
/// across all of them (the engines share it, engine orchestrator/shared-slots.ts). A workspace that runs is
/// remembered, so Forge reopens with the same workspaces started. Looking at a workspace never stops another.
extension AppModel {
    /// The project on screen (nil until its tracker project is picked).
    var viewedProject: String? { SetupStore.projectID(choices) }

    /// The link to the engine of the project on screen.
    var link: BoardLink { link(for: viewedProject) }

    /// A project's link, made on first use. Its engine lives in the project's own folder; only the project carried
    /// over from before workspaces keeps Forge's own (`ProjectRecord.folder` nil).
    func link(for id: String?) -> BoardLink {
        let key = id ?? ""
        if let l = links[key] { return l }
        let l = BoardLink(model: self, projectID: id, host: host(for: id))
        links[key] = l
        return l
    }

    func host(for id: String?) -> EngineHost {
        // Before a project is picked nothing runs; never Forge's own engine, which may be another project's.
        guard let id else { return .forProject(folder: "projects/new") }
        if let p = store.project(id) { return .forProject(folder: p.folder) }
        return .forProject(folder: SetupStore.folder(for: id))
    }

    /// The workspace a project belongs to runs, so its engine should be working.
    func shouldRun(_ project: String?) -> Bool {
        guard let id = project else { return store.current?.running == true }
        let w = store.project(id)?.workspaceID ?? (id == viewedProject ? store.current?.id : nil)
        return store.workspace(w)?.running == true
    }

    /// The projects in a workspace that can run (set up far enough), the one on screen first.
    func runnable(in w: String) -> [ProjectRecord] {
        let all = store.runnable(live: choices).filter { $0.workspaceID == w }
        return all.filter { $0.id == viewedProject } + all.filter { $0.id != viewedProject }
    }

    /// Starts every set-up project of a workspace, each in its own engine, and remembers it runs.
    func start(workspace id: String) async {
        store.setRunning(id, true)
        if !preview { store.save() }
        guard !preview else { return }
        let projects = runnable(in: id)
        if projects.isEmpty, id == workspace?.id {
            // Nothing recorded yet (setup just finished): the project on screen.
            await link.connect()
            return
        }
        for p in projects { await link(for: p.id).connect() }
    }

    /// Stops a workspace: its agents finish what they're doing; engines of projects not on screen then quit.
    func stop(workspace id: String) async {
        store.setRunning(id, false)
        if !preview { store.save() }
        guard !preview else { return }
        for p in store.projects(in: id) {
            guard let l = links[p.id] else { continue }
            await l.stop()
            if p.id != viewedProject { await l.close() }
        }
        if id == workspace?.id, store.project(viewedProject) == nil { await link.stop() }
    }

    /// The Orchestrator's Start: the workspace on screen, every set-up project in it.
    func startShown() async {
        guard let w = workspace?.id else { return await link.start() }
        await start(workspace: w)
        if viewedProject != nil, store.project(viewedProject) == nil { await link.start() }
    }

    /// The Orchestrator's Stop: the workspace on screen.
    func stopShown() async {
        guard let w = workspace?.id else { return await link.stop() }
        await stop(workspace: w)
    }

    /// Workspaces that were running started again this launch.
    static var resumed = false

    /// At launch: every workspace that was running starts again.
    func resumeRunning() async {
        guard !preview else { return }
        for w in store.workspaceList where w.running == true { await start(workspace: w.id) }
    }

    /// Quitting Forge: every engine drains.
    static func stopAllEngines() async {
        await EngineHost.shared.stop()
        for h in EngineHost.made { await h.stop() }
    }

    /// Restarts the running engines of a workspace with fresh settings (Workflow Studio saved); the one on
    /// screen restarts when the Orchestrator shows again.
    func restartEngines(in w: String, shown: Bool = true) async {
        guard !preview else { return }
        for p in store.projects(in: w) where p.id != viewedProject {
            if let l = links[p.id], store.workspace(w)?.running == true { await l.connect(restart: true) }
        }
        if shown { await link.host.stop() }
    }

    /// The project on screen changed: an engine nobody runs or looks at quits.
    func leftProject(_ old: String?) async {
        guard !preview, let old, old != viewedProject, !shouldRun(old), let l = links[old] else { return }
        await l.close()
    }

    /// The Orchestrator shows the project on screen: follow its engine, starting it when needed. Runs each time the
    /// project on screen changes, also while the Orchestrator stays on screen (a workspace opened from its top bar).
    func showBoard() async {
        boardRequests.append(viewedProject)
        let restart = settingsChanged
        settingsChanged = false
        await link.connect(restart: restart)
    }

    /// How long the Orchestrator waits for a board before it says so and offers Try again.
    nonisolated static let boardWait: Duration = .seconds(45)

    /// After `wait`, the project still on screen has no board and no problem: say so instead of reading forever.
    func watchBoard(after wait: Duration = AppModel.boardWait) async {
        let shown = viewedProject
        try? await Task.sleep(for: wait)
        guard !Task.isCancelled, viewedProject == shown, engine == nil, engineProblem == nil else { return }
        boardLate = true
    }

    /// Try again under that line: the project's engine starts afresh, and the wait starts over.
    func retryBoard() async {
        boardLate = false
        Task { await watchBoard() }
        await link.connect(restart: true)
    }

    /// Agents working now across a workspace's projects (or every workspace).
    func agentsWorking(in w: String? = nil) -> Int {
        states.filter { id, _ in w == nil || store.project(id)?.workspaceID == w }.values.reduce(0) { $0 + $1.running.count }
    }

    /// The workspaces that run.
    var runningWorkspaces: [Workspace] { store.workspaceList.filter { $0.running == true } }

    /// One table row source: a project's state with its workspace and project.
    struct Running: Identifiable {
        var workspace: Workspace
        var project: ProjectRecord
        var state: EngineState
        var id: String { project.id }
    }

    /// Every running workspace's projects with their live state, by workspace then project.
    var fleet: [Running] {
        if preview { return Self.sampleFleet(self) }
        return runningWorkspaces.flatMap { w in
            store.projects(in: w.id).compactMap { p in states[p.id].map { Running(workspace: w, project: p, state: $0) } }
        }
    }

    /// The intelligence provider and role working a stage of a project: "Builds · Codex", or the provider alone.
    func roleLine(_ project: ProjectRecord, stage: String?) -> String {
        let c = store.runChoices(project.id, live: choices)
        if let c, let stage, let r = c.roleAccounts(store).first(where: { $0.choice.role.stages.contains(stage) }) {
            return "\(r.choice.role.name) · \(r.account.provider.name)"
        }
        return (c.flatMap { store.activeAccount($0)?.provider.name }) ?? project.provider?.name ?? "—"
    }
}

extension AppModel {
    /// Render mode: the first two workspaces run.
    static func sampleRunning(_ model: AppModel) {
        for w in model.store.workspaceList.prefix(2) { model.store.setRunning(w.id, true) }
    }

    /// A second running project with one card in AI Review and one up next.
    static var sampleQuiet: EngineState {
        let review = EngineState.Card(
            id: "d1", identifier: "DC-14", title: "Fix the unread badge after a reply", state: "AI Review", activity: "Reading the diff",
            agent: .init(started_at: SampleBoard.ago(135), turn: 2, attempt: 1), helpers: [])
        let next = EngineState.Card(id: "d2", identifier: "DC-18", title: "Show who is typing", state: "Todo", helpers: [])
        var s = EngineState(status: "running", started_at: SampleBoard.ago(3900), running: [])
        s.running = [
            .init(
                issue_id: "d1", issue_identifier: "DC-14", issue_title: review.title, activity: "Reading the diff", state: "AI Review",
                started_at: SampleBoard.ago(135))
        ]
        s.board = .init(columns: [.init(name: "Todo", cards: [next]), .init(name: "AI Review", cards: [review])], read_at: SampleBoard.ago(20))
        s.usage = .init(last_24h: .init(runs: 3, inputTokens: 120_000, outputTokens: 18_000))
        return s
    }

    /// Render mode's running projects: the busy sample board in the first, a quieter one in the next.
    static func sampleFleet(_ model: AppModel) -> [Running] {
        var out: [Running] = []
        for (i, w) in model.runningWorkspaces.enumerated() {
            guard let p = model.store.projects(in: w.id).first(where: { $0.repo != nil || $0.choices != nil }) ?? model.store.projects(in: w.id).first
            else { continue }
            out.append(Running(workspace: w, project: p, state: i == 0 ? (model.engine ?? SampleBoard.state) : sampleQuiet))
        }
        return out
    }
}

extension SetupStore {
    mutating func setRunning(_ w: String, _ on: Bool) {
        guard let i = workspaces?.firstIndex(where: { $0.id == w }) else { return }
        workspaces?[i].running = on
    }
}
