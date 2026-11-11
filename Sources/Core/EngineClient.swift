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

    /// The person moves a card (Start, Merge, Ask for changes). Returns the engine's plain-words
    /// problem when the move was refused, nil when it worked.
    func move(card: String, to: String) async throws -> String? {
        try await post(card: card, "move", ["to": to])
    }

    /// Where Next step goes: the engine moves the card or runs the stage here (engine orchestrator/next-step.ts).
    static func nextStepPath(card: String) -> String { "/api/v1/cards/\(safeID(card))/next-step" }

    /// Next step: the person picks the card's next stage. Nil when it went through, else the engine's problem.
    func nextStep(card: String, stage: String) async throws -> String? {
        try await post(card: card, "next-step", ["to": stage])
    }

    /// The person's message to the agent working a card: it steers the turn in flight. Nil when it was sent.
    func message(card: String, text: String) async throws -> String? {
        try await post(card: card, "message", ["text": text])
    }

    /// Stop from the card's session (the person takes the wheel), or Hand back to Forge.
    func wheel(card: String, take: Bool) async throws -> String? {
        try await post(card: card, take ? "stop-turn" : "hand-back", [:])
    }

    /// POSTs to `/api/v1/cards/<id>/<what>`; the engine's plain-words problem when refused, nil when it worked.
    private static func safeID(_ card: String) -> String {
        card.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-"))) ?? card
    }

    private func post(card: String, _ what: String, _ body: [String: String]) async throws -> String? {
        var r = request("/api/v1/cards/\(Self.safeID(card))/\(what)", method: "POST")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: r)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(code) { return nil }
        let problem = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["problem"] as? String
        return problem ?? (what == "move" ? "Forge couldn't move the card (\(code))." : "Forge couldn't reach the card's agent (\(code)).")
    }

    struct Workpad: Decodable, Sendable, Equatable {
        var workpad: String?
        var comments: Int
    }

    /// The card's workpad note, for the card's detail.
    func workpad(card: String) async throws -> Workpad {
        let safe = card.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-"))) ?? card
        return try JSONDecoder().decode(Workpad.self, from: try await call("/api/v1/cards/\(safe)/workpad"))
    }

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
