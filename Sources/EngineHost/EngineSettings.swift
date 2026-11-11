import Foundation

/// Turns setup's answers into what the engine runs with: the workflow file (settings plus the lead's
/// instructions) and its environment (secrets from the Keychain, the GitHub sign-in, who signs).
/// Nothing secret is written to disk: the workflow names environment variables, never their values.
enum EngineSettings {
    struct Problem: Error, CustomStringConvertible {
        let description: String
    }

    static var engineDir: URL? {
        ProcessInfo.processInfo.environment["FORGE_ENGINE_DIR"].map { URL(fileURLWithPath: $0) }
            ?? Bundle.main.resourceURL?.appendingPathComponent("engine")
    }

    /// The lead's instructions, bundled with the engine (engine/workflow/lead.md).
    static var leadInstructions: String? {
        guard let url = engineDir?.appendingPathComponent("workflow/lead.md") else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }

    /// The agent skills, bundled with the engine (engine/skills); copied into each card's folder.
    static var skillsFolder: String? { engineDir?.appendingPathComponent("skills").path }

    static func quoted(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    /// The workflow file's settings block. Pure, so checks can read it.
    static func frontMatter(_ c: SetupChoices, cardsFolder: String, skillsFolder: String? = nil, store: SetupStore? = nil) -> String {
        let branch = c.defaultBranch ?? "main"
        let kind: String =
            switch c.worker ?? .claude {
            case .claude, .apiKey, .openrouter: "claude"
            case .codex, .codexKey: "codex"
            case .kimi: "kimi"
            }
        var lines = ["---", "tracker:"] + trackerLines(c)
        lines += [
            "  active_states: [\(Pipeline.activeColumns(off: c.stagesOff ?? []).map(quoted).joined(separator: ", "))]",
            "  terminal_states: [\"Done\", \"Closed\", \"Cancelled\", \"Canceled\", \"Duplicate\"]",
        ]
        lines += promoteLines(c)
        lines += [
            "board:",
            "  columns: [\(Pipeline.names.map(quoted).joined(separator: ", "))]",
            "workspace:",
            "  root: \(quoted(cardsFolder))",
            "  base_branch: \(quoted(branch))",
        ]
        if let s = skillsFolder { lines.append("  skills_dir: \(quoted(s))") }
        lines += [
            "  hooks:",
            "    after_create: |",
            "      set -e",
            "      attempt=0",
            "      until git clone --depth 1 \"$REPO_URL\" .; do",
            "        attempt=$((attempt + 1))",
            "        if [ \"$attempt\" -ge 3 ]; then echo \"git clone failed after $attempt attempts\" >&2; exit 1; fi",
            "        find . -mindepth 1 -maxdepth 1 -exec rm -rf {} +",
            "        sleep $((attempt * 5))",
            "      done",
            "    before_run: |",
            "      git fetch origin",
            "      if git rev-parse --verify \"$ISSUE_BRANCH\" >/dev/null 2>&1; then",
            "        git checkout \"$ISSUE_BRANCH\"",
            "        git merge \"origin/\(branch)\" --no-edit || true",
            "      else",
            "        git checkout -B \"$ISSUE_BRANCH\" \"origin/\(branch)\"",
            "      fi",
            "agent:",
            "  kind: \(kind)",
        ]
        if let m = c.model { lines.append("  model: \(quoted(m))") }
        lines += roleLines(c, store: store)
        lines += [
            // One lead agent per card, each sending its own helpers; the Workflow Studio screen sets how many at once.
            "  max_concurrent_agents: \(max(1, c.agentsAtOnce ?? 1))",
            "  max_turns: 20",
            "  approval_policy: bypassPermissions",
            "  turn_timeout_ms: 3600000",
            "  read_timeout_ms: 600000",
            "  stall_timeout_seconds: 900",
            "polling:",
            "  interval_ms: 30000",
            "retry:",
            "  max_attempts: 5",
            "  base_delay_seconds: 10",
        ]
        lines += marksLines(c)
        lines += ["---", ""]
        return lines.joined(separator: "\n")
    }

    /// What others see (Workflow Studio): "Keep Forge invisible", the pull request label and the branch prefix.
    /// Nothing when none is set, so the engine keeps its defaults (the `forge` label, the tracker's branches).
    static func marksLines(_ c: SetupChoices) -> [String] {
        let invisible = c.invisible ?? false
        let prefix = c.branchPrefix ?? ""
        guard invisible || c.prLabel != nil || !prefix.isEmpty else { return [] }
        var lines = ["marks:", "  invisible: \(invisible)"]
        if let l = c.prLabel { lines.append("  pr_label: \(quoted(l))") }
        if !prefix.isEmpty { lines.append("  branch_prefix: \(quoted(prefix))") }
        return lines
    }

    /// Which board the engine reads: Linear names the project (or, with none picked, the team); Basecamp also names the account, the card
    /// table, the person Forge assigns cards to, and the column id of each pipeline column.
    static func trackerLines(_ c: SetupChoices) -> [String] {
        if c.board == .github, let g = c.githubBoard {
            let cols = g.columns ?? [:]
            return [
                "  kind: github",
                "  project_slug: \(quoted(g.projectID ?? ""))",
                "  status_field_id: \(quoted(g.statusFieldID ?? ""))",
                "  columns:",
            ] + Pipeline.names.compactMap { n in cols[n].map { "    \(quoted(n)): \(quoted($0))" } }
        }
        guard c.board == .basecamp, let b = c.basecamp else {
            if let team = c.linearTeamOnly { return ["  kind: linear", "  project_slug: \"\"", "  team_id: \(quoted(team))"] }
            return ["  kind: linear", "  project_slug: \(quoted(c.projectSlug ?? ""))"]
        }
        var lines = [
            "  kind: basecamp",
            "  project_slug: \(quoted(b.projectID ?? ""))",
            "  account_id: \(quoted(b.accountID))",
            "  identity_id: \(quoted(b.personID))",
            "  card_table_id: \(quoted(b.cardTableID ?? ""))",
            "  columns:",
        ]
        let cols = b.columns ?? [:]
        lines += Pipeline.names.compactMap { n in cols[n].map { "    \(quoted(n)): \(quoted($0))" } }
        return lines
    }

    /// The tracker's section put in front of the lead's instructions (engine/workflow/basecamp.md or
    /// github.md), with this board's ids filled in. Nil for Linear.
    static func boardNote(_ c: SetupChoices, template: String?) -> String? {
        if c.board == .github, let g = c.githubBoard, let template {
            let cols = g.columns ?? [:]
            let list = Pipeline.names.compactMap { n in cols[n].map { "  - \(n): `\($0)`" } }.joined(separator: "\n")
            return
                template
                .replacingOccurrences(of: "@@PROJECT@@", with: g.projectID ?? "")
                .replacingOccurrences(of: "@@FIELD@@", with: g.statusFieldID ?? "")
                .replacingOccurrences(of: "@@REPO@@", with: g.issueRepo ?? "")
                .replacingOccurrences(of: "@@COLUMNS@@", with: list)
        }
        guard c.board == .basecamp, let b = c.basecamp, let template else { return nil }
        let cols = b.columns ?? [:]
        let list = Pipeline.names.compactMap { n in cols[n].map { "  - \(n): `\($0)`" } }.joined(separator: "\n")
        return
            template
            .replacingOccurrences(of: "@@PROJECT@@", with: b.projectID ?? "")
            .replacingOccurrences(of: "@@CARD_TABLE@@", with: b.cardTableID ?? "")
            .replacingOccurrences(of: "@@BACKLOG@@", with: cols["Backlog"] ?? "")
            .replacingOccurrences(of: "@@COLUMNS@@", with: list)
    }

    /// The command the engine and the agents' Basecamp tool run for a fresh token: this app, `--basecamp-token`,
    /// with the connection's Keychain item.
    static func basecampTokenCommand(item: String) -> String { selfCommand("--basecamp-token", item: item) }

    /// The same for a GitHub Issues board: this app, `--github-token`.
    static func githubTokenCommand(item: String) -> String { selfCommand("--github-token", item: item) }

    static func selfCommand(_ flag: String, item: String) -> String {
        let me = Bundle.main.executablePath ?? CommandLine.arguments[0]
        let data = (try? JSONSerialization.data(withJSONObject: [me, flag, "--item", item], options: [.withoutEscapingSlashes])) ?? Data()
        return String(data: data, encoding: .utf8) ?? "[]"
    }

    /// The engine moves cards out of Backlog for the person (Workflow Studio's two switches). Nothing when
    /// both are off. New cards only go to Triage while the Triage stage is on.
    static func promoteLines(_ c: SetupChoices) -> [String] {
        let toTriage = (c.sendNewToTriage ?? false) && c.stageOn("Triage")
        let toTodo = c.startReady ?? false
        guard toTriage || toTodo else { return [] }
        return ["  promote:", "    backlog_to_triage: \(toTriage)", "    ready_to_todo: \(toTodo)"]
    }

    /// The roles block: each role's stages, agent kind, model and the prefix its account arrives under. Pure.
    static func roleLines(_ c: SetupChoices, store: SetupStore?) -> [String] {
        guard let store else { return [] }
        let roles = c.roleAccounts(store)
        guard !roles.isEmpty else { return [] }
        var lines = ["  roles:"]
        for (i, r) in roles.enumerated() {
            lines.append("    - states: [\(r.choice.role.stages.map(quoted).joined(separator: ", "))]")
            lines.append("      kind: \(r.account.provider.engineKind)")
            if let m = r.choice.model, !m.isEmpty { lines.append("      model: \(quoted(m))") }
            lines.append("      env_prefix: \(quoted(SetupChoices.rolePrefix(i)))")
        }
        return lines
    }

    /// Writes the workflow file into an engine's folder. A file the person edited keeps their edits: only the
    /// settings the app owns change (WorkflowFile). Throws a plain-words problem when setup isn't finished.
    static func writeWorkflow(_ c: SetupChoices, home: URL = Paths.home, store: SetupStore? = nil) throws {
        let app = try workflowText(c, home: home, store: store)
        try FileManager.default.createDirectory(at: home.appendingPathComponent("workspaces"), withIntermediateDirectories: true)
        let file = WorkflowFile(home: home)
        if file.edited, let mine = file.text {
            try file.save(WorkflowFile.merge(edited: mine, app: app), edited: true)
        } else {
            try file.save(app, edited: false)
        }
    }

    /// The workflow file the app writes for these answers.
    static func workflowText(_ c: SetupChoices, home: URL = Paths.home, store: SetupStore? = nil) throws -> String {
        guard c.boardSlug != nil, c.repo != nil, c.worker != nil else { throw Problem(description: "Setup isn't finished yet.") }
        guard let lead = leadInstructions else { throw Problem(description: "The lead's instructions are missing from the app.") }
        let cards = home.appendingPathComponent("workspaces")
        let file = c.board == .github ? "workflow/github.md" : "workflow/basecamp.md"
        let note = boardNote(c, template: engineDir.flatMap { try? String(contentsOf: $0.appendingPathComponent(file), encoding: .utf8) })
        if c.board != .linear, note == nil { throw Problem(description: "The \(c.board.name) instructions are missing from the app.") }
        let part = (note ?? "") + (Pipeline.routingNote(off: c.stagesOff ?? []) ?? "")
        return frontMatter(c, cardsFolder: cards.path, skillsFolder: skillsFolder, store: store) + WorkflowFile.partStart + "\n" + part
            + WorkflowFile.partEnd + "\n\n" + lead
    }

    /// The engine's environment, built fresh before every start. Reads the Keychain and the `gh` sign-in.
    static func environment(_ c: SetupChoices, store: SetupStore? = nil) async throws -> [String: String] {
        guard let repo = c.repo else { throw Problem(description: "Setup isn't finished yet.") }
        let store = store ?? SetupStore.saved(for: c)
        guard let account = store.activeAccount(c) else {
            throw Problem(description: "Pick the account your intelligence provider uses in Settings.")
        }
        let secret = WorkerCheck.secret(account)
        if account.method == .key, secret == nil {
            throw Problem(description: "Forge doesn't have the \(account.provider.keyName) for \(account.name). Add it again in Settings.")
        }
        var env: [String: String] = ["REPO_URL": "https://github.com/\(repo).git"]
        // The project's own tracker connection: each keeps its sign-in in its own Keychain item.
        let item = store.trackerItem(c)
        switch c.board {
        case .linear:
            guard let linear = Keychain.get(named: item) else { throw Problem(description: "Forge doesn't have your Linear key. Run setup again.") }
            env["LINEAR_API_KEY"] = linear
        case .basecamp:
            // No token here: the engine asks this app for one (`--basecamp-token`), which renews it in the Keychain.
            guard BasecampLogin.load(item: item) != nil else { throw Problem(description: "Forge isn't signed in to Basecamp. Run setup again.") }
            env["FORGE_BASECAMP_TOKEN_COMMAND"] = basecampTokenCommand(item: item)
        case .github:
            // No token here either: the engine and the agents' tool ask this app (`--github-token`).
            guard GitHubLogin.load(item: item) != nil else {
                throw Problem(description: "Forge isn't signed in to GitHub for the board. Run setup again.")
            }
            env["FORGE_GITHUB_TOKEN_COMMAND"] = githubTokenCommand(item: item)
        }
        // Agents run unattended: the commit skill commits without asking.
        env["COMMIT_AUTO_MODE"] = "true"
        let gh = await GitHub.env(for: c.githubLogin)
        guard gh["GH_TOKEN"] != nil else { throw Problem(description: "Forge couldn't use your GitHub sign-in on this Mac.") }
        env.merge(gh) { $1 }
        // git (the clone hook and the agents) asks gh for the sign-in; nothing is stored.
        env["GIT_CONFIG_COUNT"] = "1"
        env["GIT_CONFIG_KEY_0"] = "credential.https://github.com.helper"
        env["GIT_CONFIG_VALUE_0"] = "!gh auth git-credential"
        env["FORGE_GIT_AUTHOR_NAME"] = c.authorName ?? ""
        env["FORGE_GIT_AUTHOR_EMAIL"] = c.authorEmail ?? ""
        switch c.signing ?? .unsigned {
        case .forgeKey:
            guard await ForgeSigningKey.loadIntoAgent() else { throw Problem(description: "Forge couldn't hand its signing key to your Mac.") }
            env["FORGE_GIT_SIGNING_KEY"] = ForgeSigningKey.publicKeyURL.path
            env["FORGE_GIT_SIGNING_FORMAT"] = "ssh"
        case .ownGPG:
            env["FORGE_GIT_SIGNING_KEY"] = c.signingKey ?? ""
        case .unsigned:
            env["FORGE_GIT_UNSIGNED_OK"] = "1"
        }
        // Only this account's sign-in or key, in its own login folder (WorkerCheck.env).
        let own = WorkerCheck.env(account, secret: secret)
        env.merge(own) { $1 }
        // Each role's account, under its own prefix, so two accounts never share a variable (engine agent/roles.ts).
        env.merge(try roleEnv(c, store: store, defaultVars: Array(own.keys))) { $1 }
        // One ceiling on agents across every engine on this Mac (engine orchestrator/shared-slots.ts).
        env["FORGE_AGENT_CEILING"] = String(store.agentCeiling ?? SetupStore.defaultCeiling)
        env["FORGE_AGENT_SLOTS_DIR"] = Paths.home.appendingPathComponent("slots").path
        return env
    }

    /// The roles' accounts as prefixed variables, and which variables are the default account's.
    static func roleEnv(
        _ c: SetupChoices, store: SetupStore, defaultVars: [String], secret find: (AIAccount) -> String? = WorkerCheck.secret
    ) throws -> [String: String] {
        let roles = c.roleAccounts(store)
        guard !roles.isEmpty else { return [:] }
        var env = ["FORGE_ACCOUNT_VARS": defaultVars.sorted().joined(separator: ",")]
        for (i, r) in roles.enumerated() {
            let secret = find(r.account)
            if r.account.method == .key, secret == nil {
                throw Problem(description: "Forge doesn't have the \(r.account.provider.keyName) for \(r.account.name). Add it again in Settings.")
            }
            for (k, v) in WorkerCheck.env(r.account, secret: secret) { env[SetupChoices.rolePrefix(i) + k] = v }
        }
        return env
    }

    /// Everything before an engine starts: its workflow file, then its environment.
    static func prepare(_ c: SetupChoices, store: SetupStore? = nil, host: EngineHost = .shared) async throws {
        let store = store ?? SetupStore.saved(for: c)
        try writeWorkflow(c, home: host.home, store: store)
        await host.setEnvironment(try await environment(c, store: store))
    }
}
