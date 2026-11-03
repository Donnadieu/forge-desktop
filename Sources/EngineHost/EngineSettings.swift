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
            case .codex: "codex"
            case .kimi: "kimi"
            }
        var lines = [
            "---",
            "tracker:",
            "  kind: linear",
            "  project_slug: \(quoted(c.projectSlug ?? ""))",
            "  active_states: [\(Pipeline.agentColumns.map(quoted).joined(separator: ", "))]",
            "  terminal_states: [\"Done\", \"Closed\", \"Cancelled\", \"Canceled\", \"Duplicate\"]",
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
            // One lead agent at a time; it sends its own helpers.
            "  max_concurrent_agents: 1",
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

    /// Writes the workflow file. Throws a plain-words problem when setup isn't finished.
    static func writeWorkflow(_ c: SetupChoices) throws {
        guard c.projectSlug != nil, c.repo != nil, c.worker != nil else { throw Problem(description: "Setup isn't finished yet.") }
        guard let lead = leadInstructions else { throw Problem(description: "The lead's instructions are missing from the app.") }
        try FileManager.default.createDirectory(at: Paths.cards, withIntermediateDirectories: true)
        let text = frontMatter(c, cardsFolder: Paths.cards.path, skillsFolder: skillsFolder) + lead
        try text.write(to: Paths.workflow, atomically: true, encoding: .utf8)
    }

    /// The engine's environment, built fresh before every start. Reads the Keychain and the `gh` sign-in.
    static func environment(_ c: SetupChoices) async throws -> [String: String] {
        guard let linear = Keychain.get(.linearKey) else { throw Problem(description: "Forge doesn't have your Linear key. Run setup again.") }
        guard let repo = c.repo else { throw Problem(description: "Setup isn't finished yet.") }
        var env: [String: String] = ["LINEAR_API_KEY": linear, "REPO_URL": "https://github.com/\(repo).git"]
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
        case .kimi:
            env["KIMI_API_KEY"] = Keychain.get(.kimiKey) ?? ""
        case .claude, .codex:
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
