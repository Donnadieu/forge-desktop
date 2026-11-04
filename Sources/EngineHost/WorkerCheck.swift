import Foundation

/// Setup 5's check: one real call to the chosen agent, never a "logged in" status. Claude Code can say
/// it's logged in and exit 0 while every call fails ("OAuth session expired"), so the answer is read.
enum WorkerCheck {
    enum Outcome: Equatable, Sendable {
        case works
        case fails(String)
    }

    static let prompt = "Reply with the single word: ready"

    /// The environment the agent runs with: the key from setup, if this worker needs one, or the
    /// long-lived Claude Code token Forge's sign-in kept (AgentSignIn).
    static func env(_ worker: SetupChoices.Worker, key: String?) -> [String: String] {
        if worker == .claude, let kept = Keychain.get(.claudeToken), !kept.isEmpty {
            let token = AgentSignIn.repaired(kept)
            if token != kept { Keychain.set(token, for: .claudeToken) }
            return ["CLAUDE_CODE_OAUTH_TOKEN": token]
        }
        guard let key, !key.isEmpty else { return [:] }
        switch worker {
        case .apiKey: return ["ANTHROPIC_API_KEY": key]
        case .codexKey: return ["OPENAI_API_KEY": key, "CODEX_API_KEY": key]
        case .kimi: return ["KIMI_API_KEY": key]
        case .claude, .codex: return [:]
        }
    }

    /// The Keychain item that holds this worker's key, if it signs in with one.
    static func keyItem(_ worker: SetupChoices.Worker) -> Keychain.Item? {
        switch worker {
        case .apiKey: return .anthropicKey
        case .codexKey: return .openaiKey
        case .kimi: return .kimiKey
        case .claude, .codex: return nil
        }
    }

    static func run(_ worker: SetupChoices.Worker, model: String?, key: String?) async -> Outcome {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("forge-worker-check-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        switch worker {
        case .claude, .apiKey:
            var args = ["-p", prompt, "--output-format", "json", "--max-turns", "1"]
            if let model { args += ["--model", model] }
            // An API key must win over any subscription login: drop the subscription token for that run.
            var env = Self.env(worker, key: key)
            if worker == .apiKey { env["CLAUDE_CODE_OAUTH_TOKEN"] = "" }
            let r = await Tools.run("claude", args, cwd: dir, env: env, timeout: 120)
            return claudeOutcome(r)
        case .codex, .codexKey:
            var args = ["exec", "--skip-git-repo-check", "--json", prompt]
            if let model { args += ["--model", model] }
            let r = await Tools.run("codex", args, cwd: dir, env: Self.env(worker, key: key), timeout: 180)
            return codexOutcome(r)
        case .kimi:
            return await kimiOutcome(key: key)
        }
    }

    /// Reads Claude Code's JSON answer: `is_error` and the reply, not the exit code.
    static func claudeOutcome(_ r: Tools.Result) -> Outcome {
        if r.status == 127 { return .fails("Claude Code isn't installed on this Mac.") }
        guard let line = r.out.split(separator: "\n").last(where: { $0.hasPrefix("{") }),
            let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
        else {
            return .fails(firstLine(r.err) ?? "Claude Code didn't answer.")
        }
        let reply = (obj["result"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if (obj["is_error"] as? Bool) == true || reply.isEmpty {
            return .fails("Claude Code said: \(reply.isEmpty ? "no reply" : reply)")
        }
        return .works
    }

    /// Reads Codex's event stream: a reply from the agent, and no failed turn.
    static func codexOutcome(_ r: Tools.Result) -> Outcome {
        if r.status == 127 { return .fails("Codex isn't installed on this Mac.") }
        var replied = false
        var problem: String?
        for line in r.out.split(separator: "\n") {
            guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { continue }
            let type = obj["type"] as? String ?? ""
            if type == "turn.failed" || type == "error" {
                let err = obj["error"] as? [String: Any]
                problem = err?["message"] as? String ?? obj["message"] as? String ?? "the call failed"
            }
            if type == "item.completed", let item = obj["item"] as? [String: Any],
                (item["type"] as? String) == "agent_message", !((item["text"] as? String) ?? "").isEmpty
            {
                replied = true
            }
        }
        if let problem { return .fails("Codex said: \(problem)") }
        if replied && r.ok { return .works }
        return .fails("Codex said: \(firstLine(r.err) ?? "no reply")")
    }

    /// Kimi runs on a Moonshot key: one call with it (the model list) proves the key.
    static func kimiOutcome(key: String?) async -> Outcome {
        guard let key, !key.isEmpty else { return .fails("Paste your Moonshot key first.") }
        var req = URLRequest(url: URL(string: ProcessInfo.processInfo.environment["FORGE_KIMI_ENDPOINT"] ?? "https://api.moonshot.ai/v1/models")!)
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 20
        guard let (_, resp) = try? await URLSession.shared.data(for: req), let code = (resp as? HTTPURLResponse)?.statusCode else {
            return .fails("Forge couldn't reach Moonshot.")
        }
        if code == 200 { return .works }
        return .fails(code == 401 ? "Moonshot didn't accept this key." : "Moonshot answered \(code).")
    }

    private static func firstLine(_ s: String) -> String? {
        s.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty && !$0.hasPrefix("WARNING") }
    }
}
