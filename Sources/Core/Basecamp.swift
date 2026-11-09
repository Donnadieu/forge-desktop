import Foundation

/// Basecamp's API, used by setup (the engine has its own client for the board). The token comes from
/// `BasecampLogin`. `FORGE_BASECAMP_ENDPOINT` points checks at a stand-in server.
struct BasecampAPI: Sendable {
    let accountID: String
    var endpoint = ProcessInfo.processInfo.environment["FORGE_BASECAMP_ENDPOINT"] ?? "https://3.basecampapi.com"
    /// The access token; the real one renews the sign-in when needed.
    var token: @Sendable () async throws -> String = { try await BasecampLogin.accessToken().accessToken }

    typealias Failure = BasecampLogin.Failure

    struct Person: Decodable, Sendable {
        let id: Int
        let name: String
    }
    struct DockItem: Decodable, Sendable {
        let id: Int
        let name: String
        let title: String?
        let enabled: Bool?
    }
    struct Project: Decodable, Sendable, Hashable, Identifiable {
        let id: Int
        let name: String
        let dock: [DockItem]?
        static func == (a: Project, b: Project) -> Bool { a.id == b.id }
        func hash(into h: inout Hasher) { h.combine(id) }

        /// The project's card tables (a project can have more than one).
        var cardTables: [DockItem] { (dock ?? []).filter { $0.name == "kanban_board" && $0.enabled != false } }
    }
    struct List: Decodable, Sendable, Hashable {
        let id: Int
        let title: String
        let type: String?
    }
    struct CardTable: Decodable, Sendable {
        let id: Int
        let title: String
        let lists: [List]
    }
    struct NewCard: Decodable, Sendable {
        let id: Int
        let app_url: String?
    }

    func request(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> (Data, String?) {
        let url = path.hasPrefix("http") ? path : "\(endpoint)/\(accountID)\(path)"
        guard let u = URL(string: url) else { throw Failure(description: "Bad Basecamp address.") }
        var r = URLRequest(url: u)
        r.httpMethod = method
        r.timeoutInterval = 20
        r.setValue("Bearer \(try await token())", forHTTPHeaderField: "Authorization")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.setValue(AppInfo.plainUserAgent, forHTTPHeaderField: "User-Agent")
        if let body { r.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await URLSession.shared.data(for: r)
        let http = response as? HTTPURLResponse
        let code = http?.statusCode ?? 0
        if code == 401 { throw Failure(description: "Basecamp didn't accept the sign-in. Sign in again.", signedOut: true) }
        if code == 403 { throw Failure(description: "Your Basecamp account can't do that here.") }
        if code == 404 { throw Failure(description: "Basecamp couldn't find that.") }
        if code == 429 { throw Failure(description: "Basecamp asked Forge to slow down. Try again in a minute.") }
        guard (200..<300).contains(code) else { throw Failure(description: "Basecamp answered \(code).") }
        let next = http?.value(forHTTPHeaderField: "Link").flatMap(Self.nextLink)
        return (data, next)
    }

    /// The next page's URL from Basecamp's Link header.
    static func nextLink(_ header: String) -> String? {
        for part in header.split(separator: ",") where part.contains("rel=\"next\"") {
            if let a = part.firstIndex(of: "<"), let b = part.firstIndex(of: ">"), a < b {
                return String(part[part.index(after: a)..<b])
            }
        }
        return nil
    }

    func get<T: Decodable>(_ path: String, as: T.Type) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await request("GET", path).0)
    }

    /// Every page of a list.
    func all<T: Decodable>(_ path: String, as: T.Type) async throws -> [T] {
        var out: [T] = []
        var next: String? = path
        var pages = 0
        while let p = next, pages < 50 {
            let (data, more) = try await request("GET", p)
            out += try JSONDecoder().decode([T].self, from: data)
            next = more
            pages += 1
        }
        return out
    }

    /// The one real call that proves the sign-in works: who it is.
    func me() async throws -> Person { try await get("/my/profile.json", as: Person.self) }

    func projects() async throws -> [Project] { try await all("/projects.json", as: Project.self) }

    func cardTable(project: Int, id: Int) async throws -> CardTable {
        try await get("/buckets/\(project)/card_tables/\(id).json", as: CardTable.self)
    }

    func createColumn(project: Int, table: Int, title: String) async throws {
        _ = try await request("POST", "/buckets/\(project)/card_tables/\(table)/columns.json", ["title": title])
    }

    /// Makes a card in the named column.
    func createCard(project: Int, column: Int, title: String, content: String) async throws -> NewCard {
        let (data, _) = try await request("POST", "/buckets/\(project)/card_tables/lists/\(column)/cards.json", ["title": title, "content": content])
        return try JSONDecoder().decode(NewCard.self, from: data)
    }

    /// Pipeline column name -> the Card Table column with that name (case and spacing don't matter).
    /// Basecamp's own Triage and Done columns count when their titles match.
    static func columnMap(_ table: CardTable) -> [String: String] {
        var map: [String: String] = [:]
        for c in Pipeline.columns {
            if let hit = table.lists.first(where: { Pipeline.normalized($0.title) == Pipeline.normalized(c.name) }) {
                map[c.name] = String(hit.id)
            }
        }
        return map
    }

    /// A card's Markdown text as the HTML Basecamp keeps. Basecamp's rich text takes only a few tags
    /// (div, h1, br, strong, em, a, pre, ul, ol, li, blockquote), so headings become h1 and lines divs.
    static func html(_ markdown: String) -> String {
        func esc(_ s: String) -> String {
            s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
        }
        var out: [String] = []
        var inList = false
        for raw in markdown.components(separatedBy: "\n") {
            let l = raw.trimmingCharacters(in: .whitespaces)
            let bullet = l.hasPrefix("- ") || l.hasPrefix("* ")
            if inList && !bullet {
                out.append("</ul>")
                inList = false
            }
            if bullet {
                if !inList { out.append("<ul>") }
                inList = true
                out.append("<li>\(esc(String(l.dropFirst(2))))</li>")
            } else if l.hasPrefix("#") {
                out.append("<h1>\(esc(l.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces)))</h1>")
            } else if !l.isEmpty {
                out.append("<div>\(esc(l))</div>")
            }
        }
        if inList { out.append("</ul>") }
        return out.joined()
    }

    /// Adds every missing pipeline column to the card table, in pipeline order.
    func createMissing(project: Int, table: Int, _ missing: [Column]) async throws {
        for c in missing { try await createColumn(project: project, table: table, title: c.name) }
    }
}
