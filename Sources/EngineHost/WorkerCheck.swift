import Foundation

/// Setup 5's check: one real call to the chosen agent, never a "logged in" status. Claude Code can say
/// it's logged in and exit 0 while every call fails ("OAuth session expired"), so the answer is read.
enum WorkerCheck {
    enum Outcome: Equatable, Sendable {
        case works
        case fails(String)
    }

    static let prompt = "Reply with the single word: ready"

    /// OpenRouter's Anthropic-style address: Claude Code runs on it with an OpenRouter key.
    static let openRouterBase = "https://openrouter.ai/api"

    /// The environment an account's provider runs with. Only this account's sign-in or key, and its own login
    /// folder: a browser account without a kept sign-in points Claude Code at its empty folder, so it fails as
    /// signed out instead of quietly using the person's own Claude Code login. An account carried over from before
    /// 0.2.17 (no folder) runs the way it did.
    static func env(_ a: AIAccount, secret: String?) -> [String: String] {
        let s = secret?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        switch a.worker {
        case .claude:
            if !s.isEmpty { return ["CLAUDE_CODE_OAUTH_TOKEN": AgentSignIn.repaired(s)] }
            guard let dir = a.folderURL else { return [:] }
            return ["CLAUDE_CONFIG_DIR": dir.path, "CLAUDE_CODE_OAUTH_TOKEN": ""]
        case .apiKey:
            return ["ANTHROPIC_API_KEY": s, "CLAUDE_CODE_OAUTH_TOKEN": ""]
        case .codex:
            return a.folderURL.map { ["CODEX_HOME": $0.path] } ?? [:]
        case .codexKey:
            return ["OPENAI_API_KEY": s, "CODEX_API_KEY": s]
        case .kimi:
            return ["KIMI_API_KEY": s]
        case .openrouter:
            // The engine's own OpenRouter switch (claude-env.ts) keeps the model's OpenRouter name; the rest is what
            // Claude Code itself reads, so a check outside the engine runs the same way.
            return [
                "FORGE_SMITH_EXECUTION_PROVIDER": "openrouter", "OPENROUTER_API_KEY": s, "ANTHROPIC_BASE_URL": openRouterBase,
                "ANTHROPIC_AUTH_TOKEN": s, "ANTHROPIC_API_KEY": "", "CLAUDE_CODE_OAUTH_TOKEN": "",
            ]
        }
    }

    /// The account's sign-in or key from the Keychain (a Claude sign-in kept by 0.2.7 is repaired on the way).
    static func secret(_ a: AIAccount) -> String? {
        guard let item = a.secretItem, let kept = Keychain.get(named: item), !kept.isEmpty else { return nil }
        if a.worker == .claude {
            let fixed = AgentSignIn.repaired(kept)
            if fixed != kept { Keychain.set(fixed, named: item) }
            return fixed
        }
        return kept
    }

    /// The Keychain item each way of signing in used before 0.2.17 (accounts carried over keep it).
    static func keyItem(_ worker: SetupChoices.Worker) -> Keychain.Item? {
        SetupStore.legacyItem(worker).flatMap(Keychain.Item.init(rawValue:)).flatMap { $0 == .claudeToken ? nil : $0 }
    }

    static func run(_ a: AIAccount, model: String?, secret: String?) async -> Outcome {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("forge-worker-check-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        if let folder = a.folderURL { try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
        let env = Self.env(a, secret: secret)
        switch a.worker {
        case .claude, .apiKey, .openrouter:
            if a.worker == .openrouter, (secret ?? "").isEmpty { return .fails("Paste your OpenRouter key first.") }
            var args = ["-p", prompt, "--output-format", "json", "--max-turns", "1"]
            if let model { args += ["--model", model] }
            let r = await Tools.run("claude", args, cwd: dir, env: env, timeout: 120)
            return claudeOutcome(r)
        case .codex, .codexKey:
            var args = ["exec", "--skip-git-repo-check", "--json", prompt]
            if let model { args += ["--model", model] }
            let r = await Tools.run("codex", args, cwd: dir, env: env, timeout: 180)
            return codexOutcome(r)
        case .kimi:
            return await kimiOutcome(key: secret)
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

extension WorkerCheck {
    /// What a workspace's chats and session terminals run with: its account's sign-in, exactly as its card agents
    /// get it (`env`). Empty when the workspace has no Claude Code account: the Mac's own sign-in then.
    static func sessionEnv(_ store: SetupStore, workspace: String, secret find: (AIAccount) -> String? = WorkerCheck.secret)
        -> [String: String]
    {
        guard let a = store.sessionAccount(workspace) else { return [:] }
        return env(a, secret: find(a))
    }
}
