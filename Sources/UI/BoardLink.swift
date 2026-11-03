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
            model.engineProblem = "\(error)" + (why.map { " (\($0))" } ?? "")
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

    func start() async { await send { try await $0.start() } }
    func stop() async { await send { try await $0.stop() } }
    func refresh() async { await send { try await $0.refresh() } }

    func workpad(card: String) async -> EngineClient.Workpad? {
        guard let client else { return nil }
        return try? await client.workpad(card: card)
    }

    private func send(_ f: (EngineClient) async throws -> Void) async {
        guard let client else { return }
        do { try await f(client) } catch { model?.engineProblem = "Forge's engine didn't answer: \(error)" }
    }
}
