import Foundation

/// One project's link to its engine: start it with the project's answers, follow its live state, send Start and
/// Stop. Every project has its own engine (`EngineHost.forProject`); the one on screen also feeds `model.engine`.
@MainActor
final class BoardLink {
    private weak var model: AppModel?
    /// The project (`ProjectRecord.id`); nil = the one on screen before its tracker project is picked.
    let projectID: String?
    let host: EngineHost
    private var client: EngineClient?
    private var socket: URLSessionWebSocketTask?
    private var connecting = false
    /// Closed on purpose (its workspace stopped and it's not on screen): don't reconnect.
    private var closed = false

    init(model: AppModel, projectID: String?, host: EngineHost) {
        (self.model, self.projectID, self.host) = (model, projectID, host)
    }

    /// This project is the one on screen.
    private var onScreen: Bool { model?.viewedProject == projectID }

    /// The answers its engine runs with: the ones being edited when it's on screen, else the ones it keeps.
    private func choices(_ model: AppModel) -> SetupChoices? {
        guard !onScreen, let id = projectID else { return model.choices }
        return model.store.runChoices(id, live: model.choices)
    }

    private func show(_ s: EngineState) {
        guard let model else { return }
        if let id = projectID {
            model.states[id] = s
            LimitNotifier.shared.observe(project: id, state: s, model: model)
            model.watchCardSessions()
        }
        if onScreen { model.engine = s }
    }

    private func report(_ problem: String?) {
        guard let model else { return }
        if let id = projectID { model.problems[id] = problem }
        if onScreen { model.engineProblem = problem }
    }

    /// Starts the engine if needed (fresh settings when `restart`), then follows its state. A project whose
    /// workspace is running is started again (after a restart, a crash or a relaunch of Forge).
    func connect(restart: Bool = false) async {
        guard let model, !model.preview, !connecting else { return }
        connecting = true
        closed = false
        defer { connecting = false }
        report(nil)
        do {
            if restart { await host.stop() }
            if await host.current == nil {
                guard let c = choices(model) else { throw EngineSettings.Problem(description: "This project isn't set up yet.") }
                try await EngineSettings.prepare(c, host: host)
            }
            let c = try await host.ensureStarted()
            let client = EngineClient(port: c.port, token: c.token)
            self.client = client
            var s = try await client.state()
            if model.shouldRun(projectID), !s.isRunning, s.status != "stopping" {
                try await client.start()
                s = try await client.state()
            }
            show(s)
            follow(client)
        } catch {
            let why = await host.lastFailure
            report(Self.plain(error) + (why.map { " (\($0))" } ?? ""))
        }
    }

    /// Stops following and quits its engine (agents get their usual time to finish).
    func close() async {
        closed = true
        socket?.cancel()
        socket = nil
        client = nil
        await host.stop()
        if let id = projectID { model?.states[id] = nil }
    }

    private func follow(_ client: EngineClient) {
        socket?.cancel()
        socket = client.live(
            onState: { [weak self] s in Task { @MainActor in self?.show(s) } },
            onClose: { [weak self] in
                Task { @MainActor in
                    // The engine restarted or stopped: reconnect after a moment, unless it was closed on purpose.
                    try? await Task.sleep(for: .seconds(2))
                    guard let self, !self.closed else { return }
                    await self.connect()
                }
            })
    }

    func start() async { await send(.start) { try await $0.start() } }
    func stop() async { await send(.stop) { try await $0.stop() } }
    func refresh() async { await send(.refresh) { try await $0.refresh() } }

    /// Moves cards for the person, one after another; the first refusal is shown on the board.
    func move(_ cards: [EngineState.Card], to: String) async {
        guard let client, let model, !model.preview else { return }
        model.moveProblem = nil
        for c in cards {
            do {
                if let problem = try await client.move(card: c.id, to: to) {
                    model.moveProblem = problem
                    return
                }
            } catch {
                model.moveProblem = "Forge's engine didn't answer: \(error)"
                return
            }
        }
    }

    /// Steers the agent working a card (from the card's session). Nil when sent, else the problem in plain words.
    func message(card: String, text: String) async -> String? {
        guard let client else { return "This project's engine isn't running." }
        do { return try await client.message(card: card, text: text) } catch { return "Forge's engine didn't answer: \(error)" }
    }

    func workpad(card: String) async -> EngineClient.Workpad? {
        guard let client else { return nil }
        return try? await client.workpad(card: card)
    }

    enum Action: String {
        case start = "Start"
        case stop = "Stop"
        case refresh = "Refresh"
    }

    private func send(_ action: Action, _ f: (EngineClient) async throws -> Void) async {
        guard let client else { return }
        do {
            try await f(client)
            report(nil)
        } catch {
            // The engine may have taken the request and only been slow to say so: believe its state.
            if let s = try? await client.state() {
                show(s)
                if Self.landed(action, in: s) {
                    report(nil)
                    return
                }
            }
            report(Self.didNotLand(action))
        }
    }

    /// The state already shows what the button asked for.
    nonisolated static func landed(_ action: Action, in s: EngineState) -> Bool {
        switch action {
        case .start: return s.isRunning
        case .stop: return !s.isRunning
        case .refresh: return true
        }
    }

    /// One plain line when a button's request didn't reach the engine: what happened and what to press.
    nonisolated static func didNotLand(_ action: Action) -> String {
        action == .refresh
            ? plain(URLError(.timedOut)) : "Forge's engine didn't answer, so \(action.rawValue) didn't go through. Press \(action.rawValue) again."
    }

    /// An error in plain words. Never the raw system error: that's for the logs, not the screen.
    nonisolated static func plain(_ error: Error) -> String {
        if error is URLError { return "Forge's engine didn't answer." }
        if case EngineClient.Failure.status(let code) = error { return "Forge's engine refused the request (\(code))." }
        return "\(error)"
    }
}
