import Foundation

/// A workspace: the trackers, projects, repos and intelligence providers Forge runs together. Sign-ins (tracker
/// connections, GitHub accounts, intelligence provider accounts) belong to the Mac, and any workspace can use them;
/// a workspace picks its projects. Every set-up project of a running workspace runs in its own engine, and any
/// number of workspaces run at once (AppModel+Fleet.swift).
/// Kept in `store.json` (version 2) next to the projects. Design: docs/design/workspaces-design.md.
struct Workspace: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var name: String
    /// The tile's colour, one of `Workspace.colors`.
    var color: String?
    /// The tracker connections it uses (`TrackerRecord.id`).
    var connectionIDs: [String]?
    /// The project it shows (`ProjectRecord.id`), the one opened last.
    var runningProject: String?
    /// Start was pressed and not Stop: its projects run, and start again when Forge reopens.
    var running: Bool?
    /// Workflow Studio's settings for its projects.
    var workflow: WorkflowSettings?

    static let colors = ["heat", "green", "cream", "grey", "red", "gold"]

    /// Two letters for its tile: "CE" for ConstructEase, "SP" for Side projects.
    var initials: String {
        let words = name.split { !$0.isLetter && !$0.isNumber }
        if words.count > 1 { return String(words.prefix(2).compactMap(\.first)).uppercased() }
        let word = String(words.first ?? "")
        let capitals = word.filter(\.isUppercase)
        if capitals.count >= 2 { return String(capitals.prefix(2)) }
        return word.isEmpty ? "W" : String(word.prefix(2)).uppercased()
    }
}

/// Workflow Studio's answers, kept per workspace (`setup.json` holds the running workspace's).
struct WorkflowSettings: Codable, Equatable, Sendable {
    var stagesOff: [String]?
    var agentsAtOnce: Int?
    var sendNewToTriage: Bool?
    var startReady: Bool?

    init() {}

    init(_ c: SetupChoices) {
        (stagesOff, agentsAtOnce, sendNewToTriage, startReady) = (c.stagesOff, c.agentsAtOnce, c.sendNewToTriage, c.startReady)
    }

    func apply(to c: inout SetupChoices) {
        (c.stagesOff, c.agentsAtOnce, c.sendNewToTriage, c.startReady) = (stagesOff, agentsAtOnce, sendNewToTriage, startReady)
    }
}

/// A GitHub account Forge signed in to itself (device sign-in), beside the ones the GitHub CLI has on this Mac.
struct GitHubAccountRecord: Codable, Equatable, Sendable {
    var login: String
    var name: String?

    /// Its Keychain item.
    var secretItem: String { Self.item(login) }

    static func item(_ login: String) -> String { "github-account-\(login.lowercased())" }
}

/// Where a ticked project lives on its tracker, until it's set up: Linear's team and project, Basecamp's project,
/// GitHub's project board. `slug` is what its record's id ends in (`<connection>:<slug>`).
struct ProjectRef: Codable, Equatable, Sendable {
    var team: String?
    var projectID: String
    var slug: String
}

/// The Keychain item each tracker kind used before workspaces, which a carried-over connection keeps.
enum TrackerItem {
    static func legacy(_ t: Tracker) -> String {
        switch t {
        case .linear: return Keychain.Item.linearKey.rawValue
        case .basecamp: return Keychain.Item.basecampLogin.rawValue
        case .github: return Keychain.Item.githubTrackerLogin.rawValue
        }
    }
}

extension TrackerRecord {
    /// Its Keychain item.
    var item: String { secretItem ?? TrackerItem.legacy(kind) }

    /// Its name on screen.
    var title: String { name ?? org ?? user ?? kind.name }

    /// One plain line under the name.
    var line: String { user.map { "Signed in as \($0)" } ?? "Signed in" }

    /// A new connection of a kind: its own id and Keychain item, so it never signs another out.
    static func new(_ kind: Tracker, id: String = String(UUID().uuidString.lowercased().prefix(8))) -> TrackerRecord {
        TrackerRecord(id: "\(kind.rawValue)-\(id)", kind: kind, secretItem: "tracker-\(kind.rawValue)-\(id)")
    }

    /// Puts this connection's sign-in answers into a project's settings (setup 1's answers).
    func apply(to c: inout SetupChoices) {
        c.tracker = kind
        c.connectionID = id
        switch kind {
        case .linear:
            (c.linearUser, c.linearOrg, c.linearURLKey) = (user, org, urlKey)
        case .basecamp:
            guard let a = accountID, let p = personID else { return }
            if c.basecamp?.accountID != a || c.basecamp?.personID != p {
                c.basecamp = BasecampBoard(accountID: a, accountName: org, personID: p, personName: user ?? "")
            }
        case .github:
            guard let l = login else { return }
            if c.githubBoard?.login != l { c.githubBoard = GitHubBoard(login: l, name: user) }
        }
    }
}

extension SetupChoices {
    /// The tracker connection the project uses.
    var connection: String { connectionID ?? board.rawValue }

    /// Settings with only what belongs to the Mac, not to a project: who signs commits, and every repo's
    /// Harness engineering record. A new workspace, or a project ticked but not set up, starts from these.
    func carried() -> SetupChoices {
        var n = SetupChoices()
        (n.githubLogin, n.authorName, n.authorEmail, n.signing, n.signingKey) = (githubLogin, authorName, authorEmail, signing, signingKey)
        n.harness = harness
        return n
    }
}

extension SetupStore {
    var workspaceList: [Workspace] { workspaces ?? [] }

    func workspace(_ id: String?) -> Workspace? { id.flatMap { id in workspaceList.first { $0.id == id } } }

    /// The workspace on screen.
    var current: Workspace? { workspace(currentWorkspace) ?? workspaceList.first }

    func connection(_ id: String?) -> TrackerRecord? { id.flatMap { id in trackers.first { $0.id == id } } }

    func connections(_ kind: Tracker) -> [TrackerRecord] { trackers.filter { $0.kind == kind } }

    func projects(in w: String?) -> [ProjectRecord] { projects.filter { $0.workspaceID == w } }

    /// The projects, in any workspace, that use a connection.
    func users(of connection: String) -> [ProjectRecord] { projects.filter { $0.trackerID == connection } }

    /// The workspace that manages a project.
    func owner(of projectID: String) -> Workspace? { workspace(project(projectID)?.workspaceID) }

    /// The Keychain item of the connection a project uses.
    func trackerItem(_ c: SetupChoices) -> String { connection(c.connection)?.item ?? TrackerItem.legacy(c.board) }

    mutating func putConnection(_ t: TrackerRecord) {
        if let i = trackers.firstIndex(where: { $0.id == t.id }) { trackers[i] = t } else { trackers.append(t) }
    }

    mutating func use(connection: String, in w: String) {
        guard let i = workspaces?.firstIndex(where: { $0.id == w }) else { return }
        var ids = workspaces?[i].connectionIDs ?? []
        if !ids.contains(connection) { ids.append(connection) }
        workspaces?[i].connectionIDs = ids
    }

    /// Forgets a connection no project uses. The caller removes its Keychain item.
    @discardableResult
    mutating func removeConnection(_ id: String) -> Bool {
        guard users(of: id).isEmpty else { return false }
        trackers.removeAll { $0.id == id }
        for i in workspaceList.indices { workspaces?[i].connectionIDs?.removeAll { $0 == id } }
        return true
    }

    /// Settles which projects a workspace manages on one connection: ticked ones are added (to set up when they
    /// first run), unticked ones forgotten, except the one running. Projects other workspaces manage are left alone.
    mutating func manage(_ wanted: [(id: String, name: String, ref: ProjectRef)], on connection: String, in w: String, running: String?) {
        let ids = Set(wanted.map(\.id))
        projects.removeAll { $0.workspaceID == w && $0.trackerID == connection && !ids.contains($0.id) && $0.id != running }
        for x in wanted where project(x.id) == nil {
            projects.append(
                ProjectRecord(id: x.id, trackerID: connection, name: x.name, workspaceID: w, ref: x.ref, folder: Self.folder(for: x.id)))
        }
        if !wanted.isEmpty { use(connection: connection, in: w) }
    }

    @discardableResult
    mutating func addWorkspace(name: String, color: String?) -> Workspace {
        let w = Workspace(id: "ws-" + String(UUID().uuidString.lowercased().prefix(8)), name: name, color: color, connectionIDs: [])
        workspaces = workspaceList + [w]
        return w
    }

    mutating func rename(_ id: String, to name: String, color: String?) {
        guard let i = workspaces?.firstIndex(where: { $0.id == id }) else { return }
        workspaces?[i].name = name
        workspaces?[i].color = color
    }

    /// Forgets a workspace and the projects it managed; sign-ins stay on the Mac. Never the one on screen.
    @discardableResult
    mutating func removeWorkspace(_ id: String) -> Bool {
        guard id != current?.id else { return false }
        projects.removeAll { $0.workspaceID == id }
        workspaces?.removeAll { $0.id == id }
        return true
    }

    /// Keeps the running project's answers in its record, and Workflow Studio's in its workspace.
    mutating func leave(_ c: SetupChoices) {
        if let w = current?.id, let i = workspaces?.firstIndex(where: { $0.id == w }) { workspaces?[i].workflow = WorkflowSettings(c) }
        guard let id = Self.projectID(c), let i = projects.firstIndex(where: { $0.id == id }) else { return }
        var kept = c
        kept.harness = nil
        projects[i].choices = kept
    }

    /// The answers for running a project: the ones it kept, or a fresh start on its tracker for a project ticked
    /// but not set up (nil = a workspace with nothing set up yet). Harness engineering records and, for a fresh
    /// start, who signs commits come from what runs now; Workflow Studio's from the workspace.
    func choices(for projectID: String?, in w: Workspace, from c: SetupChoices) -> SetupChoices {
        var n = c.carried()
        if let p = project(projectID), let kept = p.choices {
            n = kept
        } else if let p = project(projectID), let t = connection(p.trackerID) {
            t.apply(to: &n)
            if let r = p.ref {
                n.projectName = p.name
                switch t.kind {
                case .linear: (n.teamID, n.projectID) = (r.team, r.projectID)
                case .basecamp: n.basecamp?.projectID = r.projectID
                case .github: n.githubBoard?.projectID = r.projectID
                }
            }
        }
        n.harness = c.harness
        (w.workflow ?? WorkflowSettings()).apply(to: &n)
        return n
    }

    /// Moves Forge to a workspace and one of its projects (its running one, or the first it has): the running
    /// project's answers are kept first. Nil when the workspace doesn't exist.
    mutating func switchTo(workspace id: String, project: String? = nil, from c: SetupChoices) -> SetupChoices? {
        guard let w = workspace(id) else { return nil }
        leave(c)
        let mine = projects(in: id)
        let running = w.runningProject.flatMap { r in mine.contains { $0.id == r } ? r : nil }
        let pick = project ?? running ?? mine.first { $0.choices != nil }?.id ?? mine.first?.id
        currentWorkspace = id
        if let i = workspaces?.firstIndex(where: { $0.id == id }) { workspaces?[i].runningProject = pick }
        activeProject = pick
        return choices(for: pick, in: workspace(id) ?? w, from: c)
    }

    mutating func putGitHubAccount(_ a: GitHubAccountRecord) {
        var list = githubAccounts ?? []
        list.removeAll { $0.login.lowercased() == a.login.lowercased() }
        githubAccounts = list + [a]
    }

    /// The first time workspaces open: one workspace holds everything set up so far, and every tracker sign-in
    /// already in the Keychain becomes a connection under its old item (nothing copied, nothing signed out).
    /// True when something changed. `has` says whether a Keychain item exists.
    @discardableResult
    mutating func upgrade(_ c: SetupChoices, has: (String) -> Bool) -> Bool {
        guard workspaces == nil else { return false }
        for kind in Tracker.allCases
        where connection(kind.rawValue) == nil && (has(TrackerItem.legacy(kind)) || (c.board == kind && c.trackerUser != nil)) {
            trackers.append(TrackerRecord(id: kind.rawValue, kind: kind))
        }
        for i in trackers.indices where trackers[i].secretItem == nil {
            var t = trackers[i]
            switch t.kind {
            case .linear:
                (t.org, t.user, t.urlKey) = (t.org ?? c.linearOrg, t.user ?? c.linearUser, t.urlKey ?? c.linearURLKey)
            case .basecamp:
                guard let b = c.basecamp else { break }
                (t.org, t.user, t.accountID, t.personID) = (t.org ?? b.accountName, t.user ?? b.personName, b.accountID, b.personID)
            case .github:
                guard let g = c.githubBoard else { break }
                (t.org, t.user, t.login) = (t.org ?? "@\(g.login)", t.user ?? g.name ?? g.login, g.login)
            }
            trackers[i] = t
        }
        var used: [String] = []
        for p in projects where !used.contains(p.trackerID) { used.append(p.trackerID) }
        let w = Workspace(
            id: "ws-1", name: Self.workspaceName(c), color: "heat", connectionIDs: used, runningProject: activeProject,
            workflow: WorkflowSettings(c))
        for i in projects.indices {
            projects[i].workspaceID = w.id
            // Only the project that ran keeps Forge's own folder (its cards and history are there).
            projects[i].folder = projects[i].id == activeProject ? nil : Self.folder(for: projects[i].id)
        }
        workspaces = [w]
        currentWorkspace = w.id
        version = 3
        return true
    }

    /// Stores written before each project had its own engine folder (version 2): the project on screen keeps
    /// Forge's own folder, every other gets its own. True when something changed.
    @discardableResult
    mutating func giveFolders() -> Bool {
        guard workspaces != nil, version < 3 else { return false }
        for i in projects.indices where projects[i].folder == nil && projects[i].id != activeProject {
            projects[i].folder = Self.folder(for: projects[i].id)
        }
        version = 3
        return true
    }

    /// A project's engine folder under Forge's: `projects/<id>` with anything but letters, digits, `-` and `_` made `_`.
    static func folder(for id: String) -> String {
        "projects/" + String(id.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" })
    }

    /// A project's answers as its engine runs them: the ones being edited (`live`) when it's that project, else the
    /// ones it keeps, with its workspace's Workflow Studio answers and the Mac's Harness engineering records.
    func runChoices(_ projectID: String, live: SetupChoices) -> SetupChoices? {
        if Self.projectID(live) == projectID { return live }
        guard let p = project(projectID), var c = p.choices else { return nil }
        if let w = workspace(p.workspaceID) { (w.workflow ?? WorkflowSettings(c)).apply(to: &c) }
        c.harness = live.harness
        return c
    }

    /// Every project whose engine can run (set up far enough to write its workflow), in any workspace.
    func runnable(live: SetupChoices) -> [ProjectRecord] {
        projects.filter { p in
            guard p.workspaceID != nil, let c = runChoices(p.id, live: live) else { return false }
            return c.projectSlug != nil && c.repo != nil && c.worker != nil && c.columnsReady
        }
    }

    /// The first workspace's name: the tracker's organisation or account, else the project, else a plain one.
    static func workspaceName(_ c: SetupChoices) -> String {
        let candidates = [c.board == .github ? nil : c.trackerOrg, c.projectName]
        return candidates.compactMap { $0 }.first { !$0.isEmpty } ?? "My workspace"
    }
}
