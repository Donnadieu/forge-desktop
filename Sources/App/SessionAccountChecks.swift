import Foundation

/// Selftest checks for the account and tools a workspace's sessions run with (Omar, Nov 12): the Andela workspace's
/// chats and session terminal ran on the Mac's default Claude Code sign-in (the Forge Factory org) instead of the
/// workspace's own account, and its agents couldn't start `npx` servers. Written before the code; each failed first.
@MainActor
extension Checks {
    static func sessionAccountChecks(_ check: (String, Bool) -> Void) {
        let forge = AIAccount.new(.claude, method: .browser, name: "Forjado AI", id: "acct-forge")
        let andela = AIAccount.new(.claude, method: .browser, name: "Andela", id: "acct-andela")
        let fresh = AIAccount.new(.claude, method: .browser, name: "No token yet", id: "acct-fresh")
        var store = SetupStore()
        store.accounts = [forge, andela, fresh]
        store.projects = [
            ProjectRecord(id: "linear:p1", trackerID: "linear", name: "Intake", accountID: forge.id, workspaceID: "ws-1"),
            ProjectRecord(id: "linear:a1", trackerID: "linear-a", name: "ATC Rewrite", accountID: andela.id, workspaceID: "ws-a"),
            ProjectRecord(id: "linear:a2", trackerID: "linear-a", name: "Talent search", accountID: andela.id, workspaceID: "ws-a"),
            ProjectRecord(id: "linear:n1", trackerID: "linear-n", name: "New", accountID: fresh.id, workspaceID: "ws-n"),
        ]
        var ws = Workspace(id: "ws-a", name: "Andela")
        ws.runningProject = "linear:a2"
        store.workspaces = [Workspace(id: "ws-1", name: "Intake"), ws, Workspace(id: "ws-n", name: "New"), Workspace(id: "ws-none", name: "Chats")]
        let token = "sk-ant-oat01-andela"
        let secret: (AIAccount) -> String? = { $0.id == andela.id ? token : nil }

        check(
            "a workspace's chats run on the account its projects use, not the Mac's own sign-in",
            store.sessionAccount("ws-a")?.id == andela.id && store.sessionAccount("ws-1")?.id == forge.id)
        check(
            "they get that account's sign-in, the same variables its card agents get",
            WorkerCheck.sessionEnv(store, workspace: "ws-a", secret: secret) == WorkerCheck.env(andela, secret: token)
                && WorkerCheck.sessionEnv(store, workspace: "ws-a", secret: secret)["CLAUDE_CODE_OAUTH_TOKEN"] == token)
        check(
            "an account with no kept sign-in points its chats at its own login folder, like its agents",
            WorkerCheck.sessionEnv(store, workspace: "ws-n", secret: secret)["CLAUDE_CONFIG_DIR"] == fresh.folderURL?.path)
        check("a workspace with no project keeps the Mac's own sign-in", WorkerCheck.sessionEnv(store, workspace: "ws-none", secret: secret).isEmpty)

        let secrets = MemorySecrets()
        let vars = WorkspaceEnv.save([EnvRow(key: "RAILS_ENV", value: "dev", secret: false)], workspace: "ws-a", old: [], secrets: secrets)
        let base = WorkspaceSetup(copy: nil, setupScript: nil, cleanupScript: nil, env: vars).payload(workspace: "ws-a", secrets: secrets)
        let p = WorkspaceSetup.withAccount(base, WorkerCheck.env(andela, secret: token))
        check(
            "the sessions host gets the workspace's variables and its account's sign-in, marked secret so it's masked",
            (p["env"] as? [String: String]) == ["RAILS_ENV": "dev", "CLAUDE_CODE_OAUTH_TOKEN": token]
                && (p["secrets"] as? [String]) == ["CLAUDE_CODE_OAUTH_TOKEN"])
        let folderOnly = WorkspaceSetup.withAccount(base, WorkerCheck.env(fresh, secret: nil))
        check(
            "a login folder isn't a secret, and an empty sign-in isn't one either",
            (folderOnly["secrets"] as? [String]) == [] && (folderOnly["env"] as? [String: String])?["CLAUDE_CONFIG_DIR"] == fresh.folderURL?.path)

        let model = AppModel(preview: true)
        model.store = store
        model.accountSecret = secret
        check(
            "the session terminal gets exactly what the workspace's chats get",
            model.sessionEnv("ws-a") == (model.setupPayloads()["ws-a"]?["env"] as? [String: String])
                && model.sessionEnv("ws-a")["CLAUDE_CODE_OAUTH_TOKEN"] == token)

        let home = "/Users/p"
        let path = ToolPath.compose(
            login: "/usr/bin:/bin:/opt/homebrew/bin", home: home,
            exists: { $0 == "\(home)/.local/share/mise/shims" || $0 == "\(home)/.asdf/shims" })
        let parts = path.split(separator: ":").map(String.init)
        check(
            "agents find node and npx from mise or asdf (MCP servers started with npx), after the login shell's own",
            parts.first == "/usr/bin" && parts.contains("\(home)/.local/share/mise/shims") && parts.contains("\(home)/.asdf/shims"))
        check(
            "a version manager that isn't installed adds nothing",
            !ToolPath.compose(login: "/usr/bin", home: home, exists: { _ in false }).contains("shims"))
    }
}
