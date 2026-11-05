import Foundation

/// Selftest checks for workspaces: the first upgrade of a 0.2.17 store, several connections per tracker kind,
/// switching workspaces and projects (each keeps its answers), the project list, and what the engine's token
/// commands may read.
@MainActor
extension Checks {
    static func workspaceChecks(_ check: (String, Bool) -> Void) {
        // What 0.2.17 left on a Mac like the owner's: one Basecamp project, a Linear key from before, one account.
        var c = SetupChoices()
        c.tracker = .basecamp
        c.basecamp = BasecampBoard(accountID: "60", personID: "50", personName: "Sam Rivera", projectID: "466", cardTableID: "972")
        (c.projectID, c.projectName, c.projectSlug, c.columnsReady) = ("466", "Rails Migration", "466", true)
        (c.linearUser, c.linearOrg) = ("Sam Rivera", "Forge Factory")
        (c.githubLogin, c.authorName, c.signing) = ("samrivera", "Sam Rivera", .forgeKey)
        (c.repo, c.defaultBranch, c.repoChecked, c.worker, c.accountID, c.model, c.workerChecked, c.repoReady) =
            ("acme/rails", "main", true, .claude, "a1", "claude-opus-5", true, true)
        (c.agentsAtOnce, c.startReady) = (4, true)
        c.setHarness(HarnessRecord(merged: true), for: "acme/rails")
        var v1 = SetupStore()
        v1.accounts = [AIAccount.new(.claude, method: .browser, name: "Work", id: "a1")]
        v1.trackers = [TrackerRecord(id: "basecamp", kind: .basecamp, user: "Sam Rivera")]
        v1.sync(c)
        let v1JSON = (try? JSONEncoder().encode(v1)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
        check("a 0.2.17 store still loads", (try? JSONDecoder().decode(SetupStore.self, from: Data(v1JSON.utf8))) == v1)

        var s = v1
        let legacy: Set<String> = ["linear-key", "basecamp-login"]
        check("the first open upgrades the store once", s.upgrade(c, has: legacy.contains) && !s.upgrade(c, has: legacy.contains))
        check("one workspace holds everything set up so far", s.workspaceList.count == 1 && s.projects.allSatisfy { $0.workspaceID == "ws-1" })
        check("it's the one on screen, running the same project", s.current?.id == "ws-1" && s.current?.runningProject == "basecamp:466")
        check("it's named after the project when Basecamp gives no account name", s.current?.name == "Rails Migration")
        check("Workflow Studio's answers move into it", s.current?.workflow?.agentsAtOnce == 4 && s.current?.workflow?.startReady == true)
        let bc = s.connection("basecamp")
        check("the Basecamp sign-in keeps its old Keychain item", bc?.item == "basecamp-login" && bc?.accountID == "60" && bc?.personID == "50")
        check("the Linear key from before becomes a connection too", s.connection("linear")?.org == "Forge Factory")
        check("a kind with no sign-in in the Keychain doesn't", s.connection("github") == nil)
        check("project ids from before don't change", SetupStore.projectID(c) == "basecamp:466" && s.trackerItem(c) == "basecamp-login")

        // A second Basecamp: its own id and Keychain item, so it never signs the first out.
        var second = TrackerRecord.new(.basecamp, id: "b2")
        (second.accountID, second.personID, second.user) = ("61", "51", "Sam Rivera")
        s.putConnection(second)
        check("a new connection gets its own Keychain item", second.id == "basecamp-b2" && second.item == "tracker-basecamp-b2")
        check("there can be two of a kind", s.connections(.basecamp).count == 2)
        var onSecond = c
        second.apply(to: &onSecond)
        onSecond.projectSlug = "777"
        check("a project's id names its connection", SetupStore.projectID(onSecond) == "basecamp-b2:777")
        check("and its sign-in is that connection's", s.trackerItem(onSecond) == "tracker-basecamp-b2" && onSecond.basecamp?.accountID == "61")
        check(
            "Forge's token commands may read only tracker items",
            trackerItemAllowed("tracker-basecamp-b2") && trackerItemAllowed("linear-key")
                && !trackerItemAllowed("anthropic-key") && !trackerItemAllowed("ai-account-a1"))

        // Ticking projects under a connection.
        let devChat = ("basecamp:467", "Dev Chat", ProjectRef(projectID: "467", slug: "467"))
        let site = ("basecamp:468", "Site", ProjectRef(projectID: "468", slug: "468"))
        s.manage([devChat, site], on: "basecamp", in: "ws-1", running: "basecamp:466")
        check("ticked projects join the workspace", s.projects(in: "ws-1").count == 3 && s.project("basecamp:467")?.ref?.projectID == "467")
        s.manage([devChat], on: "basecamp", in: "ws-1", running: "basecamp:466")
        check("unticked ones leave it, the running one stays", s.project("basecamp:468") == nil && s.project("basecamp:466") != nil)
        check("a connection a project uses can't be cleared", !s.removeConnection("basecamp"))

        // Running another project in the same workspace: the one that ran keeps its answers.
        guard let fresh = s.switchTo(workspace: "ws-1", project: "basecamp:467", from: c) else { return check("switching works", false) }
        check("the project that ran keeps its answers", s.project("basecamp:466")?.choices?.repo == "acme/rails")
        check("a ticked project starts on its tracker with its project picked", fresh.basecamp?.projectID == "467" && fresh.connection == "basecamp")
        check("and asks for its columns, repo and provider next", fresh.nextScreen == 1 && fresh.repo == nil && fresh.worker == nil)
        check("who signs commits comes along", fresh.githubLogin == "samrivera" && fresh.signing == .forgeKey)
        check(
            "so do the Harness engineering records and Workflow Studio's answers",
            fresh.harness?["acme/rails"]?.merged == true && fresh.agentsAtOnce == 4)
        guard let back = s.switchTo(workspace: "ws-1", project: "basecamp:466", from: fresh) else { return check("switching back works", false) }
        check(
            "going back brings every answer back",
            back.repo == "acme/rails" && back.accountID == "a1" && back.model == "claude-opus-5" && back.nextScreen == 6)

        // A second workspace, set up from nothing.
        let side = s.addWorkspace(name: "Side projects", color: "green")
        guard let empty = s.switchTo(workspace: side.id, from: back) else { return check("opening a new workspace works", false) }
        check("a new workspace starts setup on the tracker", empty.nextScreen == 0 && s.current?.id == side.id)
        check("with nothing carried from the other workspace's project", empty.repo == nil && empty.projectSlug == nil && empty.agentsAtOnce == nil)
        check("the workspace on screen can't be deleted", !s.removeWorkspace(side.id))
        _ = s.switchTo(workspace: "ws-1", from: empty)
        check("going back opens the project it ran", s.activeProject == "basecamp:466")
        check(
            "another workspace can be deleted; its projects go, sign-ins stay",
            s.removeWorkspace(side.id) && s.workspaceList.count == 1
                && s.connections(.basecamp).count == 2)
        let saved = (try? JSONEncoder().encode(s)).flatMap { try? JSONDecoder().decode(SetupStore.self, from: $0) }
        check("the store with workspaces saves and loads unchanged", saved == s)
        check(
            "tiles get two letters",
            [Workspace(id: "", name: "ConstructEase"), Workspace(id: "", name: "Side projects"), Workspace(id: "", name: "acme")].map(\.initials)
                == ["CE", "SP", "AC"])
    }

    /// `Forge --workspaces-check`: opens the store in `FORGE_HOME` (a copy, never the person's own folder) the way the
    /// app does, upgrading it if needed, and prints what came out. Reads only whether Keychain items exist.
    static func workspacesLive() -> Int32 {
        guard ProcessInfo.processInfo.environment["FORGE_HOME"] != nil else {
            print("✗ set FORGE_HOME to a copy of Forge's folder")
            return 2
        }
        var c = SetupChoices.load()
        let s = SetupStore.load(migrating: &c)
        for w in s.workspaceList {
            print("workspace \(w.name) (\(w.id))\(w.id == s.current?.id ? " · on screen" : "")")
            for id in w.connectionIDs ?? [] {
                print("  tracker \(s.connection(id).map { "\($0.kind.name) · \($0.title) · item \($0.item)" } ?? id)")
            }
            for p in s.projects(in: w.id) {
                print("  project \(p.name) (\(p.id)) repo \(p.repo ?? "-")\(p.id == w.runningProject ? " · runs" : "")")
            }
        }
        for t in s.trackers where !s.workspaceList.contains(where: { ($0.connectionIDs ?? []).contains(t.id) }) {
            print("connection not in a workspace: \(t.kind.name) · \(t.title) · item \(t.item)")
        }
        print("running project's tracker item: \(s.trackerItem(c))")
        print(
            "upgraded: version \(s.version), backup \(FileManager.default.fileExists(atPath: Paths.home.appendingPathComponent("store.v1.json").path))"
        )
        return s.version == 2 && s.current != nil ? 0 : 1
    }
}
