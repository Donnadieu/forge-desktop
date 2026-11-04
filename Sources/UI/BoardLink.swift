import Foundation

/// The board's link to the engine: start it with setup's answers, follow its live state, send Start and Stop.
@MainActor
final class BoardLink {
    private weak var model: AppModel?
    private var client: EngineClient?
    private var socket: URLSessionWebSocketTask?
    private var connecting = false

    init(model: AppModel) { self.model = model }

    /// Starts the engine if needed (fresh settings when `restart`), then follows its state.
    func connect(restart: Bool = false) async {
        guard let model, !model.preview, !connecting else { return }
        connecting = true
        defer { connecting = false }
        model.engineProblem = nil
        do {
            if restart { await EngineHost.shared.stop() }
            if await EngineHost.shared.current == nil { try await EngineSettings.prepare(model.choices) }
            let c = try await EngineHost.shared.ensureStarted()
            let client = EngineClient(port: c.port, token: c.token)
            self.client = client
            model.engine = try await client.state()
            follow(client)
        } catch {
            let why = await EngineHost.shared.lastFailure
            model.engineProblem = Self.plain(error) + (why.map { " (\($0))" } ?? "")
        }
    }

    private func follow(_ client: EngineClient) {
        socket?.cancel()
        socket = client.live(
            onState: { [weak self] s in Task { @MainActor in self?.model?.engine = s } },
            onClose: { [weak self] in
                Task { @MainActor in
                    // The engine restarted or stopped: reconnect after a moment.
                    try? await Task.sleep(for: .seconds(2))
                    await self?.connect()
                }
            })
    }

    func start() async { await send(.start) { try await $0.start() } }
    func stop() async { await send(.stop) { try await $0.stop() } }
    func refresh() async { await send(.refresh) { try await $0.refresh() } }

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
            model?.engineProblem = nil
        } catch {
            // The engine may have taken the request and only been slow to say so: believe its state.
            if let s = try? await client.state() {
                model?.engine = s
                if Self.landed(action, in: s) {
                    model?.engineProblem = nil
                    return
                }
            }
            model?.engineProblem = Self.didNotLand(action)
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
