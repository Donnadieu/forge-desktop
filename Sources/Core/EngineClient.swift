import Foundation

/// Talks to the running engine over its local API: 127.0.0.1, the port it reported, and the launch token.
/// Commands go over HTTP; the board state arrives over a WebSocket whenever it changes.
struct EngineClient: Sendable {
    let port: Int
    let token: String

    enum Failure: Error, Equatable {
        case status(Int)
    }

    private func request(_ path: String, method: String) -> URLRequest {
        var r = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
        r.httpMethod = method
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.timeoutInterval = 15
        return r
    }

    /// Calls the API and returns the body. `withToken: false` exists so checks can prove a request without it is refused.
    func call(_ path: String, method: String = "GET", withToken: Bool = true) async throws -> Data {
        var r = request(path, method: method)
        if !withToken { r.setValue(nil, forHTTPHeaderField: "Authorization") }
        let (data, response) = try await URLSession.shared.data(for: r)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw Failure.status(code) }
        return data
    }

    func state() async throws -> EngineState {
        try EngineState.decode(try await call("/api/v1/state"))
    }

    func start() async throws { _ = try await call("/api/v1/start", method: "POST") }
    func stop() async throws { _ = try await call("/api/v1/stop", method: "POST") }
    func refresh() async throws { _ = try await call("/api/v1/refresh", method: "POST") }

    /// Opens the live state stream. `onState` runs for every pushed state; `onClose` once when the stream ends.
    func live(onState: @escaping @Sendable (EngineState) -> Void, onClose: @escaping @Sendable () -> Void) -> URLSessionWebSocketTask {
        let task = URLSession.shared.webSocketTask(with: request("/api/v1/live", method: "GET"))
        @Sendable func receive() {
            task.receive { result in
                switch result {
                case .success(let message):
                    if case .string(let text) = message, let frame = try? EngineState.decodeFrame(Data(text.utf8)) {
                        onState(frame)
                    }
                    receive()
                case .failure:
                    onClose()
                }
            }
        }
        task.resume()
        receive()
        return task
    }
}

/// The engine's state as the app shows it. Unknown fields are ignored, so the engine can grow without breaking the app.
struct EngineState: Decodable, Sendable, Equatable {
    /// "running", "stopping" or "stopped".
    var status: String
    var running: [RunningCard]
    var poll: Poll?

    struct RunningCard: Decodable, Sendable, Equatable {
        var issue_identifier: String
        var issue_title: String?
        var last_message: String?
        var turn_count: Int?
    }

    struct Poll: Decodable, Sendable, Equatable {
        var lastPollAt: String?
        var lastPollError: String?
    }

    static func decode(_ data: Data) throws -> EngineState {
        try JSONDecoder().decode(EngineState.self, from: data)
    }

    private struct Frame: Decodable {
        var type: String
        var state: EngineState
    }

    static func decodeFrame(_ data: Data) throws -> EngineState {
        try JSONDecoder().decode(Frame.self, from: data).state
    }
}
