import Foundation

/// `Forge --apply-setup <answers.json>`: the setup screens' answers without the window, through the same
/// real checks (Linear's viewer call, the push check, a signed test commit, the agent's real call).
/// Keys come from the environment (FORGE_SETUP_LINEAR_KEY, FORGE_SETUP_AGENT_KEY), never the file;
/// they go into the Keychain only after their check passes. Used for unattended end-to-end runs.
enum SetupApply {
    struct Answers: Decodable {
        var githubAccount: String?
        var team: String
        var project: String
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

        // 1. Linear
        guard let key = env["FORGE_SETUP_LINEAR_KEY"] ?? Keychain.get(.linearKey) else { throw Stop(description: "no Linear key") }
        let linear = LinearAPI(key: key)
        let viewer = try await linear.viewer()
        guard Keychain.set(key, for: .linearKey) else { throw Stop(description: "couldn't save the Linear key") }
        c.linearUser = viewer.name
        c.linearOrg = viewer.organization.name
        print("✓ Linear: \(viewer.name) in \(viewer.organization.name)")

        // 2. Project and columns
        guard let team = try await linear.teams().first(where: { $0.name == a.team || $0.key == a.team }) else {
            throw Stop(description: "no Linear team \(a.team)")
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
}
