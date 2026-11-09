import Foundation

/// Talks to the sessions host over its local API (127.0.0.1, its port, the launch token), like EngineClient does
/// for a board engine. Live changes arrive over one WebSocket.
struct SessionsClient: Sendable {
    let port: Int
    let token: String

    struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    private func request(_ path: String, method: String, body: [String: Any]? = nil, timeout: TimeInterval = 30) throws -> URLRequest {
        var r = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
        r.httpMethod = method
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.timeoutInterval = timeout
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return r
    }

    /// Calls the API; a refusal comes back as its plain-words problem.
    @discardableResult
    func call(_ path: String, method: String = "GET", body: [String: Any]? = nil, timeout: TimeInterval = 30) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: try request(path, method: method, body: body, timeout: timeout))
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(code) { return data }
        let problem = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["problem"] as? String
        throw Failure(description: problem ?? "Forge's sessions didn't answer (\(code)).")
    }

    func get<T: Decodable>(_ path: String, as: T.Type) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await call(path))
    }

    private static func q(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+"))) ?? s
    }

    struct List: Decodable { var sessions: [Sessions.Session] }
    struct Turns: Decodable {
        var turns: [Sessions.Turn]
        var total: Int
    }
    struct Changes: Decodable { var files: [Sessions.FileChange] }
    struct Diff: Decodable { var diff: String }
    struct PR: Decodable { var pr: Sessions.PullRequest? }
    struct Threads: Decodable {
        var ok: Bool
        var problem: String?
        var threads: [Sessions.ReviewThread]
    }
    struct Created: Decodable { var session: Sessions.Session? }

    func sessions() async throws -> [Sessions.Session] { try await get("/api/v1/sessions", as: List.self).sessions }

    func create(_ body: [String: Any]) async throws -> Sessions.Session? {
        try JSONDecoder().decode(Created.self, from: try await call("/api/v1/sessions", method: "POST", body: body, timeout: 900)).session
    }

    func newChat(session: String, model: String, effort: String, title: String, message: String = "") async throws {
        try await call(
            "/api/v1/sessions/\(session)/chats", method: "POST", body: ["model": model, "effort": effort, "title": title, "message": message])
    }

    func turns(chat: String, before: Int? = nil, limit: Int = 50) async throws -> Turns {
        try await get("/api/v1/chats/\(chat)/turns?limit=\(limit)" + (before.map { "&before=\($0)" } ?? ""), as: Turns.self)
    }

    func send(chat: String, text: String, queue: Bool) async throws {
        try await call("/api/v1/chats/\(chat)/messages", method: "POST", body: ["text": text, "mode": queue ? "queue" : "steer"])
    }

    func stop(chat: String) async throws { try await call("/api/v1/chats/\(chat)/stop", method: "POST", body: [:]) }

    func answer(chat: String, event: String, allow: Bool, answers: [String: String]? = nil, feedback: String? = nil) async throws {
        var b: [String: Any] = ["eventId": event, "allow": allow]
        if let answers { b["answers"] = answers }
        if let feedback { b["feedback"] = feedback }
        try await call("/api/v1/chats/\(chat)/answer", method: "POST", body: b)
    }

    func settings(chat: String, _ b: [String: Any]) async throws {
        try await call("/api/v1/chats/\(chat)/settings", method: "POST", body: b)
    }

    func revert(chat: String, turn: String) async throws {
        try await call("/api/v1/chats/\(chat)/revert", method: "POST", body: ["turnId": turn])
    }

    func read(session: String) async throws { try await call("/api/v1/sessions/\(session)/read", method: "POST", body: [:]) }
    func changes(session: String) async throws -> [Sessions.FileChange] {
        try await get("/api/v1/sessions/\(session)/changes", as: Changes.self).files
    }
    func diff(session: String, path: String) async throws -> String {
        try await get("/api/v1/sessions/\(session)/diff?path=\(Self.q(path))", as: Diff.self).diff
    }
    func pullRequest(session: String) async throws -> Sessions.PullRequest? {
        try await get("/api/v1/sessions/\(session)/pr", as: PR.self).pr
    }
    func reviewThreads(session: String) async throws -> [Sessions.ReviewThread] {
        let t = try await get("/api/v1/sessions/\(session)/review-comments", as: Threads.self)
        if let p = t.problem, !t.ok { throw Failure(description: p) }
        return t.threads
    }
    func merge(session: String) async throws { try await call("/api/v1/sessions/\(session)/merge", method: "POST", body: [:], timeout: 180) }
    func archive(session: String) async throws { try await call("/api/v1/sessions/\(session)/archive", method: "POST", body: [:], timeout: 120) }
    func conductor() async throws -> Sessions.ConductorPreview { try await get("/api/v1/conductor", as: Sessions.ConductorPreview.self) }
    func importConductor(targets: [String: String], workspace: String) async throws {
        try await call("/api/v1/conductor/import", method: "POST", body: ["targets": targets, "workspace": workspace], timeout: 600)
    }

    /// Opens the live stream; `onFrame` runs for each change, `onClose` once when it ends.
    func live(onFrame: @escaping @Sendable (Sessions.Frame) -> Void, onClose: @escaping @Sendable () -> Void) -> URLSessionWebSocketTask {
        var r = URLRequest(url: URL(string: "ws://127.0.0.1:\(port)/api/v1/live")!)
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let task = URLSession.shared.webSocketTask(with: r)
        task.maximumMessageSize = 64 * 1024 * 1024
        @Sendable func receive() {
            task.receive { result in
                switch result {
                case .success(let message):
                    if case .string(let text) = message, let f = Sessions.decodeFrame(Data(text.utf8)) { onFrame(f) }
                    receive()
                case .failure: onClose()
                }
            }
        }
        task.resume()
        receive()
        return task
    }
}
