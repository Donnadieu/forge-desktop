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
    static func frontMatter(_ c: SetupChoices, cardsFolder: String, skillsFolder: String? = nil) -> String {
        let branch = c.defaultBranch ?? "main"
        let kind: String =
            switch c.worker ?? .claude {
            case .claude, .apiKey: "claude"
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
            "---",
            "",
        ]
        return lines.joined(separator: "\n")
    }

    /// Which board the engine reads: Linear names the project; Basecamp also names the account, the card
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

    /// The command the engine and the agents' Basecamp tool run for a fresh token: this app, `--basecamp-token`.
    static var basecampTokenCommand: String { selfCommand("--basecamp-token") }

    /// The same for a GitHub Issues board: this app, `--github-token`.
    static var githubTokenCommand: String { selfCommand("--github-token") }

    private static func selfCommand(_ flag: String) -> String {
        let me = Bundle.main.executablePath ?? CommandLine.arguments[0]
        let data = (try? JSONSerialization.data(withJSONObject: [me, flag], options: [.withoutEscapingSlashes])) ?? Data()
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

    /// Writes the workflow file. Throws a plain-words problem when setup isn't finished.
    static func writeWorkflow(_ c: SetupChoices) throws {
        guard c.projectSlug != nil, c.repo != nil, c.worker != nil else { throw Problem(description: "Setup isn't finished yet.") }
        guard let lead = leadInstructions else { throw Problem(description: "The lead's instructions are missing from the app.") }
        try FileManager.default.createDirectory(at: Paths.cards, withIntermediateDirectories: true)
        let file = c.board == .github ? "workflow/github.md" : "workflow/basecamp.md"
        let note = boardNote(c, template: engineDir.flatMap { try? String(contentsOf: $0.appendingPathComponent(file), encoding: .utf8) })
        if c.board != .linear, note == nil { throw Problem(description: "The \(c.board.name) instructions are missing from the app.") }
        let text =
            frontMatter(c, cardsFolder: Paths.cards.path, skillsFolder: skillsFolder) + (note ?? "")
            + (Pipeline.routingNote(off: c.stagesOff ?? []) ?? "") + lead
        try text.write(to: Paths.workflow, atomically: true, encoding: .utf8)
    }

    /// The engine's environment, built fresh before every start. Reads the Keychain and the `gh` sign-in.
    static func environment(_ c: SetupChoices) async throws -> [String: String] {
        guard let repo = c.repo else { throw Problem(description: "Setup isn't finished yet.") }
        var env: [String: String] = ["REPO_URL": "https://github.com/\(repo).git"]
        switch c.board {
        case .linear:
            guard let linear = Keychain.get(.linearKey) else { throw Problem(description: "Forge doesn't have your Linear key. Run setup again.") }
            env["LINEAR_API_KEY"] = linear
        case .basecamp:
            // No token here: the engine asks this app for one (`--basecamp-token`), which renews it in the Keychain.
            guard BasecampLogin.load() != nil else { throw Problem(description: "Forge isn't signed in to Basecamp. Run setup again.") }
            env["FORGE_BASECAMP_TOKEN_COMMAND"] = basecampTokenCommand
        case .github:
            // No token here either: the engine and the agents' tool ask this app (`--github-token`).
            guard GitHubLogin.load() != nil else { throw Problem(description: "Forge isn't signed in to GitHub for the board. Run setup again.") }
            env["FORGE_GITHUB_TOKEN_COMMAND"] = githubTokenCommand
        }
        // Agents run unattended: the commit skill commits without asking.
        env["COMMIT_AUTO_MODE"] = "true"
        GitHub.account = c.githubLogin
        let gh = await GitHub.env()
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
        switch c.worker ?? .claude {
        case .apiKey:
            env["ANTHROPIC_API_KEY"] = Keychain.get(.anthropicKey) ?? ""
            env["CLAUDE_CODE_OAUTH_TOKEN"] = ""
        case .codexKey:
            env["OPENAI_API_KEY"] = Keychain.get(.openaiKey) ?? ""
            env["CODEX_API_KEY"] = env["OPENAI_API_KEY"]
        case .kimi:
            env["KIMI_API_KEY"] = Keychain.get(.kimiKey) ?? ""
        case .claude:
            // The long-lived token from Forge's sign-in; without one the agents use Claude Code's own login.
            env.merge(WorkerCheck.env(.claude, key: nil)) { $1 }
        case .codex:
            break
        }
        return env
    }

    /// Everything before the engine starts: the workflow file, then the environment.
    static func prepare(_ c: SetupChoices) async throws {
        try writeWorkflow(c)
        await EngineHost.shared.setEnvironment(try await environment(c))
    }
}
