import Foundation

/// GitHub's GraphQL API for setup on a GitHub Issues board (the engine has its own client for the board):
/// who is signed in, their projects, a project's Status field and repos, adding the missing Status options,
/// linking a repo, and making an issue on the board. The token comes from `GitHubLogin`.
/// `FORGE_GITHUB_GRAPHQL` points checks at a stand-in server.
struct GitHubProjectsAPI: Sendable {
    var endpoint = ProcessInfo.processInfo.environment["FORGE_GITHUB_GRAPHQL"] ?? "https://api.github.com/graphql"
    var token: @Sendable () throws -> String = { try GitHubLogin.accessToken() }

    typealias Failure = BasecampLogin.Failure

    struct Viewer: Decodable, Sendable {
        let id: String
        let login: String
        let name: String?
    }
    struct Option: Codable, Sendable, Hashable {
        let id: String
        let name: String
        var color: String? = nil
        var description: String? = nil
    }
    struct StatusField: Decodable, Sendable {
        let id: String
        let options: [Option]
    }
    struct Project: Decodable, Sendable, Hashable, Identifiable {
        let id: String
        let number: Int
        let title: String
        let url: String
        let closed: Bool?
        /// The account that owns it (a person or an organization).
        var owner: String { URL(string: url)?.pathComponents.dropFirst(2).first ?? "" }
    }
    struct ProjectDetail: Sendable {
        let project: Project
        let status: StatusField?
        /// Repos linked to the project (`owner/name`).
        let repos: [String]
        /// Each of GitHub's automations that would move cards behind Forge's back, on or off (see `movingWorkflows`).
        var automations: [Automation] = []
        /// The ones still on.
        var movers: [String] {
            get { automations.filter(\.on).map(\.name) }
            set {
                automations = GitHubProjectsAPI.movingWorkflows.map { n in Automation(name: n, on: newValue.contains(n), why: automationWhy[n] ?? "")
                }
            }
        }
    }

    /// The project's built-in workflows that set a card's Status on their own. "Item added to project" puts
    /// a new card in Todo (so an untriaged follow-up would be built), and "Pull request linked to issue"
    /// pulls a card back to In Progress (seen live: Human Review → In Progress). Closing and merging → Done
    /// agree with Forge, so those stay on.
    static let movingWorkflows = [
        "Item added to project", "Item reopened", "Pull request linked to issue", "Code changes requested", "Code review approved",
    ]

    /// One of `movingWorkflows`, as this project has it.
    struct Automation: Equatable, Sendable {
        let name: String
        let on: Bool
        /// What it would do to a card behind Forge's back.
        let why: String
    }

    static let automationWhy = [
        "Item added to project": "puts every new card in Todo, so agents would build a follow-up nobody looked at",
        "Item reopened": "moves a reopened card back to a column of its own",
        "Pull request linked to issue": "pulls a card back to In Progress when its pull request is linked",
        "Code changes requested": "moves a card when a review asks for changes",
        "Code review approved": "moves a card when a review approves it",
    ]

    /// Each automation Forge needs off, on or off in this project. GitHub lets a workflow be duplicated under the
    /// same name: any copy that's on counts.
    static func automations(_ workflows: [[String: Any]]) -> [Automation] {
        let on = Set(movers(workflows))
        return movingWorkflows.map { Automation(name: $0, on: on.contains($0), why: automationWhy[$0] ?? "") }
    }

    /// The enabled ones among `movingWorkflows`, from the project's `workflows` list.
    static func movers(_ workflows: [[String: Any]]) -> [String] {
        let on = workflows.filter { ($0["enabled"] as? Bool) == true }.compactMap { $0["name"] as? String }
        return movingWorkflows.filter { on.contains($0) }
    }
    struct NewIssue: Sendable {
        let id: String
        let number: Int
        let url: String
    }

    func graphql(_ query: String, _ variables: [String: Any] = [:]) async throws -> [String: Any] {
        try Self.checked(try await answer(query, variables))
    }

    /// GitHub's whole answer: `data` and, when part of it failed, `errors` beside it.
    func answer(_ query: String, _ variables: [String: Any] = [:]) async throws -> [String: Any] {
        guard let u = URL(string: endpoint) else { throw Failure(description: "Bad GitHub address.") }
        var r = URLRequest(url: u)
        r.httpMethod = "POST"
        r.timeoutInterval = 30
        r.setValue("Bearer \(try token())", forHTTPHeaderField: "Authorization")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.setValue(AppInfo.plainUserAgent, forHTTPHeaderField: "User-Agent")
        r.httpBody = try JSONSerialization.data(withJSONObject: ["query": query, "variables": variables])
        let (data, response) = try await URLSession.shared.data(for: r)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 { throw Failure(description: "GitHub didn't accept the sign-in. Sign in again.", signedOut: true) }
        guard (200..<300).contains(code) else { throw Failure(description: "GitHub answered \(code).") }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    /// The answer's `data`, or its errors as a failure (a missing scope is a sign-in problem).
    static func checked(_ obj: [String: Any]) throws -> [String: Any] {
        let errors = obj["errors"] as? [[String: Any]] ?? []
        if errors.contains(where: isScopeError) { throw Failure(description: missingProjectAccess, signedOut: true) }
        if !errors.isEmpty { throw Failure(description: "GitHub said: \(errors.compactMap { $0["message"] as? String }.joined(separator: "; "))") }
        return obj["data"] as? [String: Any] ?? [:]
    }

    static func isScopeError(_ e: [String: Any]) -> Bool {
        let text = "\(e["type"] ?? "") \(e["message"] ?? "")"
        return text.contains("INSUFFICIENT_SCOPES") || text.contains("required scopes")
    }

    static let missingProjectAccess = "GitHub's sign-in can't read your projects: it wasn't given project access."

    static func decode<T: Decodable>(_ value: Any?, as: T.Type) throws -> T {
        guard let value else { throw Failure(description: "GitHub sent an empty answer.") }
        return try JSONDecoder().decode(T.self, from: try JSONSerialization.data(withJSONObject: value))
    }

    /// The one real call that proves the sign-in works: who it is.
    func viewer() async throws -> Viewer {
        try Self.decode(try await graphql("query { viewer { id login name } }")["viewer"], as: Viewer.self)
    }

    private static let projectFields = "id number title url closed"

    /// What the project list found: the open projects, and the organizations GitHub kept from this sign-in.
    struct ProjectList: Sendable {
        var projects: [Project]
        /// Organizations whose projects GitHub wouldn't show (OAuth app access restrictions, SAML single sign-on).
        var hidden: [String] = []
    }

    /// The person's own projects and their organizations' projects, open ones only.
    func projects() async throws -> ProjectList {
        let q = """
            query { viewer {
              projectsV2(first: 50) { nodes { \(Self.projectFields) } }
              organizations(first: 30) { nodes { login projectsV2(first: 50) { nodes { \(Self.projectFields) } } } }
            } }
            """
        return try Self.projectList(try await answer(q))
    }

    /// Reads the project list. An organization that keeps its projects from Forge's sign-in fails only its own
    /// part of the answer: the rest still counts, and the organization is named so the screen can say why.
    static func projectList(_ obj: [String: Any]) throws -> ProjectList {
        let errors = obj["errors"] as? [[String: Any]] ?? []
        func orgIndex(_ e: [String: Any]) -> Int? {
            let path = e["path"] as? [Any] ?? []
            guard path.count > 3, path[0] as? String == "viewer", path[1] as? String == "organizations" else { return nil }
            return path[3] as? Int
        }
        if errors.contains(where: isScopeError) { _ = try checked(obj) }
        let rest = errors.filter { orgIndex($0) == nil }
        if !rest.isEmpty { _ = try checked(["errors": rest]) }
        var orgErrors: [Int: [String: Any]] = [:]
        for e in errors { if let i = orgIndex(e) { orgErrors[i] = e } }
        let v = (obj["data"] as? [String: Any])?["viewer"] as? [String: Any] ?? [:]
        func open(_ owner: Any?) -> [Project] {
            let nodes = ((owner as? [String: Any])?["projectsV2"] as? [String: Any])?["nodes"] as? [Any] ?? []
            return nodes.compactMap { $0 is NSNull ? nil : try? decode($0, as: Project.self) }.filter { $0.closed != true }
        }
        var list = ProjectList(projects: open(v))
        let orgs = (v["organizations"] as? [String: Any])?["nodes"] as? [Any] ?? []
        for (i, org) in orgs.enumerated() {
            if let e = orgErrors[i] {
                list.hidden.append((org as? [String: Any])?["login"] as? String ?? orgName(in: e["message"] as? String) ?? "an organization")
            } else {
                list.projects += open(org)
            }
        }
        for (i, e) in orgErrors where i >= orgs.count { list.hidden.append(orgName(in: e["message"] as? String) ?? "an organization") }
        return list
    }

    /// GitHub names the organization in backticks: "the `acme` organization has enabled OAuth App access restrictions".
    static func orgName(in message: String?) -> String? {
        let parts = (message ?? "").components(separatedBy: "`")
        return parts.count > 2 && !parts[1].isEmpty ? parts[1] : nil
    }

    /// The project with its Status field and linked repos.
    func project(_ id: String) async throws -> ProjectDetail {
        let q = """
            query($id: ID!) { node(id: $id) { ... on ProjectV2 {
              \(Self.projectFields)
              field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name color description } } }
              repositories(first: 50) { nodes { nameWithOwner } }
              workflows(first: 30) { nodes { name enabled } }
            } } }
            """
        guard let node = try await graphql(q, ["id": id])["node"] as? [String: Any] else {
            throw Failure(description: "GitHub couldn't find that project.")
        }
        let status = (node["field"] as? [String: Any]).flatMap { $0["id"] == nil ? nil : try? Self.decode($0, as: StatusField.self) }
        let repos = ((node["repositories"] as? [String: Any])?["nodes"] as? [[String: Any]] ?? []).compactMap { $0["nameWithOwner"] as? String }
        let flows = (node["workflows"] as? [String: Any])?["nodes"] as? [[String: Any]] ?? []
        return ProjectDetail(project: try Self.decode(node, as: Project.self), status: status, repos: repos, automations: Self.automations(flows))
    }

    /// Pipeline column name -> the Status option with that name (case and spacing don't matter).
    static func columnMap(_ options: [Option]) -> [String: String] {
        var map: [String: String] = [:]
        for c in Pipeline.columns {
            if let hit = options.first(where: { Pipeline.normalized($0.name) == Pipeline.normalized(c.name) }) { map[c.name] = hit.id }
        }
        return map
    }

    /// GitHub's option colour for a pipeline column.
    static func color(_ column: String) -> String {
        switch column {
        case "Backlog", "Todo": return "GRAY"
        case "Triage": return "ORANGE"
        case "In Progress": return "YELLOW"
        case "AI Review", "Done": return "PURPLE"
        case "QA", "Merging": return "BLUE"
        case "Human Review": return "GREEN"
        default: return "RED"
        }
    }

    /// The Status options after adding the missing columns, in pipeline order: every existing option kept
    /// with its id (so no card loses its column), new ones where they belong, other options at the end.
    static func optionsWith(_ existing: [Option], adding missing: [Column]) -> [[String: Any]] {
        func kept(_ o: Option) -> [String: Any] { ["id": o.id, "name": o.name, "color": o.color ?? "GRAY", "description": o.description ?? ""] }
        var used = Set<String>()
        var out: [[String: Any]] = []
        for c in Pipeline.columns {
            if let o = existing.first(where: { Pipeline.normalized($0.name) == Pipeline.normalized(c.name) }) {
                out.append(kept(o))
                used.insert(o.id)
            } else if missing.contains(where: { $0.name == c.name }) {
                out.append(["name": c.name, "color": color(c.name), "description": c.line])
            }
        }
        return out + existing.filter { !used.contains($0.id) }.map(kept)
    }

    /// Adds every missing pipeline column to the project's Status field.
    func createMissing(field: StatusField, _ missing: [Column]) async throws {
        let q = """
            mutation($field: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
              updateProjectV2Field(input: { fieldId: $field, singleSelectOptions: $options }) { clientMutationId }
            }
            """
        _ = try await graphql(q, ["field": field.id, "options": Self.optionsWith(field.options, adding: missing)])
    }

    /// Repos the signed-in person can push to, most recently pushed first.
    func repos() async throws -> [String] {
        let q = """
            query { viewer { repositories(first: 100, orderBy: { field: PUSHED_AT, direction: DESC },
              affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) { nodes { nameWithOwner viewerPermission } } } }
            """
        let nodes = ((try await graphql(q)["viewer"] as? [String: Any])?["repositories"] as? [String: Any])?["nodes"] as? [[String: Any]] ?? []
        return nodes.filter { ["ADMIN", "MAINTAIN", "WRITE"].contains($0["viewerPermission"] as? String ?? "") }
            .compactMap { $0["nameWithOwner"] as? String }
    }

    func repoID(_ fullName: String) async throws -> String {
        let parts = fullName.split(separator: "/").map(String.init)
        guard parts.count == 2 else { throw Failure(description: "Pick a repo as owner/name.") }
        let q = "query($o: String!, $n: String!) { repository(owner: $o, name: $n) { id } }"
        guard let id = (try await graphql(q, ["o": parts[0], "n": parts[1]])["repository"] as? [String: Any])?["id"] as? String else {
            throw Failure(description: "GitHub couldn't find \(fullName).")
        }
        return id
    }

    /// Links the repo to the project, so its issues and pull requests show there.
    func link(project: String, repo: String) async throws {
        let q = "mutation($p: ID!, $r: ID!) { linkProjectV2ToRepository(input: { projectId: $p, repositoryId: $r }) { clientMutationId } }"
        _ = try await graphql(q, ["p": project, "r": try await repoID(repo)])
    }

    /// Makes an issue in `repo`, puts it on the project and sets its Status to `option`.
    func createIssue(repo: String, project: String, field: String, option: String, title: String, body: String) async throws -> NewIssue {
        let make =
            "mutation($r: ID!, $t: String!, $b: String!) { createIssue(input: { repositoryId: $r, title: $t, body: $b }) { issue { id number url } } }"
        let made = try await graphql(make, ["r": try await repoID(repo), "t": title, "b": body])
        guard let issue = (made["createIssue"] as? [String: Any])?["issue"] as? [String: Any], let id = issue["id"] as? String,
            let number = issue["number"] as? Int, let url = issue["url"] as? String
        else { throw Failure(description: "GitHub didn't make the issue.") }
        let add = "mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input: { projectId: $p, contentId: $c }) { item { id } } }"
        let item =
            ((try await graphql(add, ["p": project, "c": id])["addProjectV2ItemById"] as? [String: Any])?["item"] as? [String: Any])?["id"] as? String
        guard let item else { throw Failure(description: "GitHub didn't put the issue on the project.") }
        let set = """
            mutation($p: ID!, $i: ID!, $f: ID!, $o: String!) {
              updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: { singleSelectOptionId: $o } }) { clientMutationId }
            }
            """
        _ = try await graphql(set, ["p": project, "i": item, "f": field, "o": option])
        return NewIssue(id: id, number: number, url: url)
    }
}
