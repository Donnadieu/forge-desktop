import Foundation

/// Setup 6's first half: an agent reads the whole repo, read-only, with the bundled `repo-assessment`
/// skill, and answers with an assessment and the guardrails worth adding. Runs in a fresh shallow clone
/// in a scratch folder, so nothing in the person's checkouts is touched.
enum RepoReader {
    struct Report: Codable, Equatable, Sendable {
        var summary: [String]
        var has: [String]?
        var missing: [String]?
        var risks: [String]?
        var guardrails: [Guardrail]
    }

    typealias Guardrail = HarnessGuardrail

    struct Problem: Error, CustomStringConvertible {
        let description: String
    }

    /// Where the last report is kept, so closing Forge mid-way doesn't lose it.
    static var reportFile: URL { Paths.home.appendingPathComponent("repo-report.json") }

    static func saved(for repo: String) -> Report? {
        guard let d = try? Data(contentsOf: reportFile), let s = try? JSONDecoder().decode(Saved.self, from: d), s.repo == repo else { return nil }
        return s.report
    }

    private struct Saved: Codable {
        var repo: String
        var report: Report
    }

    static func save(_ r: Report, repo: String) {
        try? FileManager.default.createDirectory(at: Paths.home, withIntermediateDirectories: true)
        try? JSONEncoder().encode(Saved(repo: repo, report: r)).write(to: reportFile, options: .atomic)
    }

    /// The skill's instructions, without its front matter.
    static var instructions: String? {
        guard let url = EngineSettings.engineDir?.appendingPathComponent("skills/repo-assessment/SKILL.md"),
            let text = try? String(contentsOf: url, encoding: .utf8)
        else { return nil }
        let parts = text.components(separatedBy: "\n---\n")
        return parts.count > 1 ? parts.dropFirst().joined(separator: "\n---\n") : text
    }

    static func read(_ c: SetupChoices) async throws -> Report {
        guard let repo = c.repo, let worker = c.worker else { throw Problem(description: "Pick the repo and the agent first.") }
        guard let skill = instructions else { throw Problem(description: "The repo-reading instructions are missing from the app.") }
        if worker == .kimi { throw Problem(description: "Reading the repo works with Claude Code or Codex for now.") }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("forge-repo-read-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        GitHub.account = c.githubLogin
        let clone = await GitHub.gh(["repo", "clone", repo, dir.path, "--", "--depth", "1", "--quiet"], timeout: 600)
        guard clone.ok else { throw Problem(description: "Forge couldn't download \(repo) to read it.") }
        let prompt = skill + "\n\nAssess the repository in the current folder (\(repo)). Read only; change nothing."
        let text: String
        switch worker {
        case .claude, .apiKey:
            var args = ["-p", prompt, "--output-format", "json", "--allowedTools", "Read,Grep,Glob", "--max-turns", "80"]
            if let m = c.model { args += ["--model", m] }
            var env = WorkerCheck.env(worker, key: worker == .apiKey ? Keychain.get(.anthropicKey) : nil)
            if worker == .apiKey { env["CLAUDE_CODE_OAUTH_TOKEN"] = "" }
            let r = await Tools.run("claude", args, cwd: dir, env: env, timeout: 1800)
            guard let obj = lastJSONLine(r.out), (obj["is_error"] as? Bool) != true, let result = obj["result"] as? String else {
                throw Problem(description: "Claude Code didn't finish reading the repo.")
            }
            text = result
        case .codex, .codexKey:
            var args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--json", prompt]
            if let m = c.model { args += ["--model", m] }
            let env = WorkerCheck.env(worker, key: WorkerCheck.keyItem(worker).flatMap { Keychain.get($0) })
            let r = await Tools.run("codex", args, cwd: dir, env: env, timeout: 1800)
            guard let reply = codexReply(r.out) else { throw Problem(description: "Codex didn't finish reading the repo.") }
            text = reply
        case .kimi:
            throw Problem(description: "Reading the repo works with Claude Code or Codex for now.")
        }
        guard let report = parse(text) else { throw Problem(description: "The agent's answer didn't include the guardrail list.") }
        save(report, repo: repo)
        return report
    }

    /// The last fenced ```json block in the agent's answer.
    static func parse(_ text: String) -> Report? {
        let blocks = text.components(separatedBy: "```json")
        guard blocks.count > 1, let body = blocks.last?.components(separatedBy: "```").first else { return nil }
        return try? JSONDecoder().decode(Report.self, from: Data(body.utf8))
    }

    private static func lastJSONLine(_ out: String) -> [String: Any]? {
        guard let line = out.split(separator: "\n").last(where: { $0.hasPrefix("{") }) else { return nil }
        return try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
    }

    private static func codexReply(_ out: String) -> String? {
        var last: String?
        for line in out.split(separator: "\n") {
            guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                (obj["type"] as? String) == "item.completed", let item = obj["item"] as? [String: Any],
                (item["type"] as? String) == "agent_message", let t = item["text"] as? String
            else { continue }
            last = t
        }
        return last
    }

    /// The card's description: what was found, the chosen guardrails, and which skill to follow.
    static func cardText(_ r: Report, chosen: [Guardrail]) -> String {
        var lines = [
            "Get this repo ready for coding agents. Follow the `harness-engineering` skill: build the guardrails below in one pull request.",
            "",
            "## What the assessment found",
        ]
        lines += r.summary.map { "- \($0)" }
        if let m = r.missing, !m.isEmpty { lines += ["", "**Missing:**"] + m.map { "- \($0)" } }
        if let k = r.risks, !k.isEmpty { lines += ["", "**Risks:**"] + k.map { "- \($0)" } }
        lines += ["", "## Guardrails to add (chosen by the owner)"]
        lines += chosen.map { "- [ ] **\($0.title)** (`\($0.id)`): \($0.why)" }
        lines += [
            "",
            "## Done when",
            "- Every guardrail above runs in a pre-commit hook, one local command, and CI on every pull request.",
            "- Each custom rule has a one-line why and a FIX line, and a canary proves it blocks.",
            "- Existing violations are in a baseline that may only shrink, listed in the PR body as follow-up work.",
            "- AGENTS.md maps the repo and points at the commands.",
        ]
        return lines.joined(separator: "\n")
    }
}
