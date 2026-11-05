import Foundation

/// `Forge --apply-setup <answers.json>`: the setup screens' answers without the window, through the same
/// real checks (Linear's viewer call or Basecamp's, the push check, a signed test commit, the agent's real call).
/// Basecamp and GitHub Issues need a sign-in first (`Forge --basecamp-sign-in`, `Forge --github-sign-in`).
/// Keys come from the environment (FORGE_SETUP_LINEAR_KEY, FORGE_SETUP_AGENT_KEY), never the file;
/// they go into the Keychain only after their check passes. Used for unattended end-to-end runs.
enum SetupApply {
    struct Answers: Decodable {
        var githubAccount: String?
        /// Where the cards live (default Linear).
        var tracker: Tracker?
        /// Linear only.
        var team: String?
        /// The Linear project, the Basecamp project, or the GitHub project's title.
        var project: String
        /// Basecamp only, when the project has more than one card table.
        var cardTable: String?
        /// GitHub Issues only: the repo new issues go to (default: `repo`).
        var issueRepo: String?
        var createMissingColumns: Bool?
        var signing: SetupChoices.Signing
        var gpgKey: String?
        var registerForgeKey: Bool?
        var repo: String
        var worker: SetupChoices.Worker
        var model: String?
        /// Mark the Ready screen done (true = skip it; it can be run later from Workflow).
        var skipRepoReady: Bool?
    }

    static func run(_ path: String) -> Int32 {
        let done = DispatchSemaphore(value: 0)
        final class Box: @unchecked Sendable { var code: Int32 = 1 }
        let box = Box()
        Task.detached {
            do {
                try await apply(path)
                box.code = 0
            } catch {
                print("✗ \(error)")
            }
            done.signal()
        }
        done.wait()
        return box.code
    }

    struct Stop: Error, CustomStringConvertible {
        let description: String
    }

    static func apply(_ path: String) async throws {
        let env = ProcessInfo.processInfo.environment
        guard let data = FileManager.default.contents(atPath: path) else { throw Stop(description: "no answers at \(path)") }
        let a = try JSONDecoder().decode(Answers.self, from: data)
        var c = SetupChoices.load()

        if a.tracker == .basecamp {
            try await applyBasecamp(a, &c)
        } else if a.tracker == .github {
            try await applyGitHub(a, &c)
        } else {
            try await applyLinear(a, &c, key: env["FORGE_SETUP_LINEAR_KEY"])
        }

        // 3. GitHub and who signs
        let accounts = await GitHub.accounts()
        GitHub.account = a.githubAccount ?? accounts.first
        guard let user = await GitHub.user() else { throw Stop(description: "gh isn't signed in") }
        var name = user.name
        var email = user.noreplyEmail
        var signingKey: String?
        switch a.signing {
        case .forgeKey:
            if !ForgeSigningKey.exists, !(await ForgeSigningKey.make(comment: "Forge signing key for @\(user.login)")) {
                throw Stop(description: "couldn't make a key")
            }
            if !(await ForgeSigningKey.registered()) {
                guard a.registerForgeKey == true else { throw Stop(description: "Forge's key isn't on GitHub and registering wasn't approved") }
                let r = await ForgeSigningKey.register(title: "Forge")
                guard r == .done else { throw Stop(description: "GitHub didn't add the key (\(r))") }
                print("✓ added Forge's signing key to @\(user.login)")
            }
            guard await ForgeSigningKey.loadIntoAgent() else { throw Stop(description: "ssh-agent didn't take the key") }
            signingKey = ForgeSigningKey.publicKeyURL.path
        case .ownGPG:
            guard let k = await GitHub.gpgKeys().first(where: { $0.id == a.gpgKey }) else { throw Stop(description: "no GPG key \(a.gpgKey ?? "")") }
            name = k.name
            email = k.email
            signingKey = k.id
        case .unsigned:
            break
        }
        guard await GitHub.signs(name: name, email: email, signing: a.signing, key: signingKey) else {
            throw Stop(description: "a test commit didn't come out signed")
        }
        c.githubLogin = user.login
        c.authorName = name
        c.authorEmail = email
        c.signing = a.signing
        c.signingKey = signingKey
        print("✓ commits by \(name), \(a.signing.rawValue)")

        // 4. The repo
        guard await GitHub.canPush(a.repo) else { throw Stop(description: "can't push to \(a.repo)") }
        let branch = await GitHub.gh(["api", "repos/\(a.repo)", "--jq", ".default_branch"]).out.trimmingCharacters(in: .whitespacesAndNewlines)
        c.repo = a.repo
        c.defaultBranch = branch.isEmpty ? "main" : branch
        c.repoChecked = true
        print("✓ can push to \(a.repo)")

        // 5. Who does the work
        let agentKey = env["FORGE_SETUP_AGENT_KEY"]
        guard case .works = await WorkerCheck.run(a.worker, model: a.model, key: agentKey) else {
            let r = await WorkerCheck.run(a.worker, model: a.model, key: agentKey)
            throw Stop(description: "the agent didn't answer: \(r)")
        }
        if let agentKey, let item = WorkerCheck.keyItem(a.worker) { _ = Keychain.set(agentKey, for: item) }
        c.worker = a.worker
        c.model = a.model
        c.workerChecked = true
        print("✓ \(a.worker.rawValue) answered a real call")

        if a.skipRepoReady == true { c.repoReady = true }
        c.save()
        print(c.repoReady == true ? "✓ setup saved; Forge opens on the board" : "✓ setup saved; Forge opens on the Ready screen")
    }

    static func applyLinear(_ a: Answers, _ c: inout SetupChoices, key: String?) async throws {
        c.tracker = .linear
        // 1. Linear
        guard let key = key ?? Keychain.get(.linearKey) else { throw Stop(description: "no Linear key") }
        let linear = LinearAPI(key: key)
        let viewer = try await linear.viewer()
        guard Keychain.set(key, for: .linearKey) else { throw Stop(description: "couldn't save the Linear key") }
        c.linearUser = viewer.name
        c.linearOrg = viewer.organization.name
        print("✓ Linear: \(viewer.name) in \(viewer.organization.name)")

        // 2. Project and columns
        guard let team = try await linear.teams().first(where: { $0.name == a.team || $0.key == a.team }) else {
            throw Stop(description: "no Linear team \(a.team ?? "")")
        }
        guard let project = try await linear.projects(team: team.id).first(where: { $0.name == a.project }) else {
            throw Stop(description: "no project \(a.project) in \(team.name)")
        }
        var missing = Pipeline.missing(existing: try await linear.states(team: team.id).map(\.name))
        if !missing.isEmpty, a.createMissingColumns == true {
            for note in try await linear.createMissing(team: team.id, missing) { print("· \(note)") }
            missing = Pipeline.missing(existing: try await linear.states(team: team.id).map(\.name))
        }
        guard missing.isEmpty || missing.map(\.name) == ["Triage"] && team.triageEnabled == true else {
            throw Stop(description: "the team is missing \(missing.map(\.name).joined(separator: ", "))")
        }
        c.teamID = team.id
        c.teamName = team.name
        c.projectID = project.id
        c.projectName = project.name
        c.projectSlug = project.slugId
        c.columnsReady = true
        print("✓ project \(project.name) in \(team.name); all ten columns there")
    }

    static func applyBasecamp(_ a: Answers, _ c: inout SetupChoices) async throws {
        guard let login = BasecampLogin.load(), let account = login.accountID else {
            throw Stop(description: "not signed in to Basecamp (run Forge --basecamp-sign-in)")
        }
        let api = BasecampAPI(accountID: account)
        let me = try await api.me()
        print("✓ Basecamp: \(me.name) in account \(account)")
        guard let project = try await api.projects().first(where: { $0.name == a.project }) else {
            throw Stop(description: "no Basecamp project \(a.project)")
        }
        guard let dock = project.cardTables.first(where: { a.cardTable == nil || $0.title == a.cardTable }) else {
            throw Stop(description: "\(project.name) has no card table")
        }
        var table = try await api.cardTable(project: project.id, id: dock.id)
        var missing = Pipeline.missing(existing: table.lists.map(\.title))
        if !missing.isEmpty, a.createMissingColumns == true {
            try await api.createMissing(project: project.id, table: table.id, missing)
            table = try await api.cardTable(project: project.id, id: dock.id)
            missing = Pipeline.missing(existing: table.lists.map(\.title))
        }
        guard missing.isEmpty else { throw Stop(description: "the card table is missing \(missing.map(\.name).joined(separator: ", "))") }
        c.tracker = .basecamp
        c.basecamp = BasecampBoard(
            accountID: account, accountName: c.basecamp?.accountName, personID: String(me.id), personName: me.name,
            projectID: String(project.id), projectName: project.name, cardTableID: String(table.id),
            columns: BasecampAPI.columnMap(table))
        c.projectID = String(project.id)
        c.projectName = project.name
        c.projectSlug = String(project.id)
        c.columnsReady = true
        print("✓ card table \(table.title) in \(project.name); all ten columns there")
    }

    static func applyGitHub(_ a: Answers, _ c: inout SetupChoices) async throws {
        guard GitHubLogin.load() != nil else { throw Stop(description: "not signed in to GitHub for the board (run Forge --github-sign-in)") }
        let api = GitHubProjectsAPI()
        let me = try await api.viewer()
        print("✓ GitHub board sign-in: \(me.login)")
        guard let found = try await api.projects().first(where: { $0.title == a.project }) else {
            throw Stop(description: "no GitHub project \(a.project)")
        }
        var project = try await api.project(found.id)
        guard var status = project.status else { throw Stop(description: "\(found.title) has no Status field") }
        var missing = Pipeline.missing(existing: status.options.map(\.name))
        if !missing.isEmpty, a.createMissingColumns == true {
            try await api.createMissing(field: status, missing)
            project = try await api.project(found.id)
            status = project.status ?? status
            missing = Pipeline.missing(existing: status.options.map(\.name))
        }
        guard missing.isEmpty else { throw Stop(description: "the project's Status is missing \(missing.map(\.name).joined(separator: ", "))") }
        guard project.movers.isEmpty else {
            throw Stop(description: "turn off GitHub's \(project.movers.joined(separator: ", ")) workflows at \(found.url)/workflows")
        }
        let repo = a.issueRepo ?? a.repo
        if !project.repos.contains(repo) {
            try await api.link(project: found.id, repo: repo)
            print("· linked \(repo) to \(found.title)")
        }
        c.tracker = .github
        c.githubBoard = GitHubBoard(
            login: me.login, name: me.name, projectID: found.id, projectTitle: found.title, projectURL: found.url, statusFieldID: status.id,
            columns: GitHubProjectsAPI.columnMap(status.options), issueRepo: repo)
        (c.projectID, c.projectName, c.projectSlug, c.columnsReady) = (found.id, found.title, found.id, true)
        print("✓ project \(found.title); all ten columns in its Status")
    }

    /// `Forge --github-sign-in`: GitHub's device sign-in for the board without the window.
    static func githubSignIn() -> Int32 {
        let done = DispatchSemaphore(value: 0)
        final class Box: @unchecked Sendable { var code: Int32 = 1 }
        let box = Box()
        Task.detached {
            do {
                let code = try await GitHubLogin.start()
                print("Open \(code.verificationURL) and enter the code \(code.userCode)")
                fflush(stdout)
                let t = try await GitHubLogin.finish(code)
                print(t.canUseProjects ? "✓ signed in to GitHub with the projects permission" : "✗ signed in, but without the projects permission")
                box.code = t.canUseProjects ? 0 : 1
            } catch {
                print("✗ \(error)")
            }
            done.signal()
        }
        done.wait()
        return box.code
    }

    /// `Forge --basecamp-sign-in`: prints the link and the code, waits for the approval, keeps the sign-in.
    static func basecampSignIn() -> Int32 {
        let done = DispatchSemaphore(value: 0)
        final class Box: @unchecked Sendable { var code: Int32 = 1 }
        let box = Box()
        Task.detached {
            do {
                let code = try await BasecampLogin.start()
                print("Open \(code.verificationURL) and approve the code \(code.userCode)")
                fflush(stdout)
                let t = try await BasecampLogin.finish(code)
                print("✓ signed in to Basecamp account \(t.accountID ?? "?")")
                box.code = 0
            } catch {
                print("✗ \(error)")
            }
            done.signal()
        }
        done.wait()
        return box.code
    }
}
