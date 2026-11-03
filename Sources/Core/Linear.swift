import Foundation

/// Linear's GraphQL API, used by setup (the engine has its own client for the board).
/// `FORGE_LINEAR_ENDPOINT` points checks at a stand-in server.
struct LinearAPI: Sendable {
    let key: String
    var endpoint = URL(string: ProcessInfo.processInfo.environment["FORGE_LINEAR_ENDPOINT"] ?? "https://api.linear.app/graphql")!

    struct Failure: Error, CustomStringConvertible {
        let message: String
        var description: String { message }
    }

    struct Viewer: Decodable, Sendable {
        let id: String
        let name: String
        let email: String?
        let organization: Org
    }
    struct Org: Decodable, Sendable {
        let name: String
        let urlKey: String
    }
    struct Team: Decodable, Sendable, Hashable, Identifiable {
        let id: String
        let name: String
        let key: String
        let triageEnabled: Bool?
    }
    struct Project: Decodable, Sendable, Hashable, Identifiable {
        let id: String
        let name: String
        let slugId: String
    }
    struct State: Decodable, Sendable, Hashable {
        let id: String
        let name: String
        let type: String
    }

    private struct Nodes<T: Decodable>: Decodable { let nodes: [T] }

    func run<T: Decodable>(_ query: String, _ variables: [String: Any] = [:], as: T.Type) async throws -> T {
        var r = URLRequest(url: endpoint)
        r.httpMethod = "POST"
        r.setValue(key, forHTTPHeaderField: "Authorization")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.timeoutInterval = 20
        r.httpBody = try JSONSerialization.data(withJSONObject: ["query": query, "variables": variables])
        let (data, response) = try await URLSession.shared.data(for: r)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 || code == 403 { throw Failure(message: "Linear didn't accept this key.") }
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        if let errors = obj?["errors"] as? [[String: Any]], let first = errors.first {
            let msg = first["message"] as? String ?? "unknown error"
            if msg.lowercased().contains("authentication") { throw Failure(message: "Linear didn't accept this key.") }
            throw Failure(message: "Linear said: \(msg)")
        }
        guard (200..<300).contains(code), let d = obj?["data"] else { throw Failure(message: "Linear answered \(code).") }
        return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: d))
    }

    /// The one real call that proves the key works.
    func viewer() async throws -> Viewer {
        struct R: Decodable { let viewer: Viewer }
        return try await run("query { viewer { id name email organization { name urlKey } } }", as: R.self).viewer
    }

    func teams() async throws -> [Team] {
        struct R: Decodable { let teams: Nodes<Team> }
        return try await run("query { teams(first: 100) { nodes { id name key triageEnabled } } }", as: R.self).teams.nodes
    }

    func projects(team: String) async throws -> [Project] {
        struct T: Decodable { let projects: Nodes<Project> }
        struct R: Decodable { let team: T }
        let q = "query($id: String!) { team(id: $id) { projects(first: 100) { nodes { id name slugId } } } }"
        return try await run(q, ["id": team], as: R.self).team.projects.nodes
    }

    func states(team: String) async throws -> [State] {
        struct T: Decodable { let states: Nodes<State> }
        struct R: Decodable { let team: T }
        let q = "query($id: String!) { team(id: $id) { states(first: 100) { nodes { id name type } } } }"
        return try await run(q, ["id": team], as: R.self).team.states.nodes
    }

    func createState(team: String, column: Column) async throws {
        struct P: Decodable { let success: Bool }
        struct R: Decodable { let workflowStateCreate: P }
        let q = """
            mutation($input: WorkflowStateCreateInput!) { workflowStateCreate(input: $input) { success } }
            """
        let input: [String: Any] = ["teamId": team, "name": column.name, "type": column.kind, "color": column.color]
        let r = try await run(q, ["input": input], as: R.self)
        if !r.workflowStateCreate.success { throw Failure(message: "Linear didn't create \(column.name).") }
    }

    /// Triage is a team switch in Linear, not a normal status. Turns it on; false if Linear refuses.
    func enableTriage(team: String) async -> Bool {
        struct P: Decodable { let success: Bool }
        struct R: Decodable { let teamUpdate: P }
        let q = "mutation($id: String!) { teamUpdate(id: $id, input: { triageEnabled: true }) { success } }"
        return (try? await run(q, ["id": team], as: R.self).teamUpdate.success) ?? false
    }

    /// Creates every missing column. Triage: the team switch first, a plain status if Linear refuses.
    func createMissing(team: String, _ missing: [Column]) async throws -> [String] {
        var notes: [String] = []
        for column in missing {
            if column.kind == "triage" {
                if await enableTriage(team: team) {
                    notes.append("Turned on Triage for the team.")
                    continue
                }
                try await createState(team: team, column: Column(name: column.name, kind: "unstarted", color: column.color, line: column.line))
                notes.append("Linear wouldn't turn on its Triage switch, so Triage is a plain column.")
                continue
            }
            try await createState(team: team, column: column)
        }
        return notes
    }
}
