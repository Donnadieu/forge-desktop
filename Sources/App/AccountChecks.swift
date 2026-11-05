import Foundation

/// Selftest checks for intelligence provider accounts: the store (trackers → projects → provider → account),
/// carrying over settings from before 0.2.17, switching accounts and projects, clearing, and what each account
/// hands the engine.
@MainActor
extension Checks {
    static func accountChecks(_ check: (String, Bool) -> Void) {
        var old = SetupChoices()
        (old.linearUser, old.linearOrg, old.projectSlug, old.projectName, old.columnsReady) = ("Sam", "Acme", "bot", "AI Trading Bot", true)
        (old.repo, old.defaultBranch, old.repoChecked, old.worker, old.model, old.workerChecked) =
            ("acme/bot", "main", true, .claude, "claude-sonnet-5", true)
        let (moved, chosen) = SetupStore.migrate(old, has: { $0 == "claude-code-token" || $0 == "anthropic-key" })
        check("old settings carry over: the sign-in they used becomes the project's account", chosen == "mac-claude")
        let carried = moved.account("mac-claude")
        check(
            "a carried-over sign-in keeps its Keychain item and has no folder, so it runs as before",
            carried?.secretItem == "claude-code-token" && carried?.folder == nil && carried?.method == .browser)
        check("every key already in the Keychain becomes an account too", moved.account("mac-apiKey")?.secretItem == "anthropic-key")
        check("keys that aren't in the Keychain don't", moved.account("mac-kimi") == nil && moved.accounts.count == 2)
        check("the tracker carries over", moved.trackers == [TrackerRecord(id: "linear", kind: .linear, org: "Acme", user: "Sam")])
        let project = moved.project("linear:bot")
        check(
            "the project carries over, mapped to its repo, provider and account",
            project?.repo == "acme/bot" && project?.provider == .claude && project?.accountID == "mac-claude" && project?.trackerID == "linear")
        check("the carried-over project is the one Forge runs", moved.activeProject == "linear:bot")
        check("keys found without a setup still become accounts", SetupStore.migrate(SetupChoices(), has: { _ in true }).store.accounts.count == 4)
        check("no setup and no keys: no accounts", SetupStore.migrate(SetupChoices(), has: { _ in false }).store == SetupStore())
        let file = #"{"worker":"claude","linearUser":"a","projectSlug":"bot","columnsReady":true,"repoChecked":true,"workerChecked":true}"#
        let decoded = try? JSONDecoder().decode(SetupChoices.self, from: Data(file.utf8))
        check("settings saved by 0.2.16 still load, with no account yet", decoded != nil && decoded?.accountID == nil)
        check("until then the carried-over account is the project's", decoded.map { moved.activeAccount($0)?.id } == "mac-claude")
        let roundTrip = (try? JSONEncoder().encode(moved)).flatMap { try? JSONDecoder().decode(SetupStore.self, from: $0) }
        check("the store saves and loads unchanged", roundTrip == moved)

        // Accounts: each keeps its own Keychain item and login folder.
        let personal = AIAccount.new(.claude, method: .browser, name: "Personal", id: "p1")
        let work = AIAccount.new(.claude, method: .browser, name: "Work", id: "w1")
        check(
            "two Claude Code accounts never share a sign-in or a login folder",
            personal.secretItem != work.secretItem && personal.folder != work.folder && personal.folder != nil)
        check("a Codex browser account keeps its sign-in in its own folder", AIAccount.new(.codex, method: .browser, name: "C").secretItem == nil)
        let workEnv = WorkerCheck.env(work, secret: "sk-ant-oat01-x")
        check(
            "a signed-in Claude account hands agents only its own sign-in",
            workEnv == ["CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-x"])
        let noToken = WorkerCheck.env(work, secret: nil)
        check(
            "a Claude account without its sign-in uses its own empty folder, never the Mac's own login",
            noToken["CLAUDE_CONFIG_DIR"] == work.folderURL?.path && noToken["CLAUDE_CODE_OAUTH_TOKEN"] == "")
        check("a carried-over Claude sign-in without one runs as it did", carried.map { WorkerCheck.env($0, secret: nil) } == [:])
        let codex = AIAccount.new(.codex, method: .browser, name: "Codex", id: "c1")
        check("a Codex account signs in and runs in its own folder", WorkerCheck.env(codex, secret: nil)["CODEX_HOME"] == codex.folderURL?.path)
        let router = AIAccount.new(.openrouter, method: .key, name: "OR", id: "o1")
        let routerEnv = WorkerCheck.env(router, secret: "sk-or-1")
        check(
            "OpenRouter runs Claude Code on OpenRouter with its key, and no Anthropic sign-in can stand in",
            routerEnv["ANTHROPIC_BASE_URL"] == WorkerCheck.openRouterBase && routerEnv["ANTHROPIC_AUTH_TOKEN"] == "sk-or-1"
                && routerEnv["ANTHROPIC_API_KEY"] == "" && routerEnv["CLAUDE_CODE_OAUTH_TOKEN"] == ""
                && routerEnv["FORGE_SMITH_EXECUTION_PROVIDER"] == "openrouter")
        var onRouter = old
        onRouter.worker = .openrouter
        check("OpenRouter's agents are Claude Code", EngineSettings.frontMatter(onRouter, cardsFolder: "/c").contains("  kind: claude\n"))
        check("an OpenRouter account is a key", router.worker == .openrouter && router.worker.usesKey)

        // Switching: each project keeps its own account.
        var store = moved
        store.put(work)
        var c = old
        c.accountID = "mac-claude"
        store.sync(c)
        (c.projectSlug, c.projectName, c.repo) = ("site", "Website", "acme/site")
        check("a project Forge hasn't seen keeps the answers on screen", !store.adopt(into: &c) && c.accountID == "mac-claude")
        (c.accountID, c.worker) = (work.id, work.worker)
        store.sync(c)
        check(
            "switching the account changes only that project",
            store.project("linear:site")?.accountID == "w1"
                && store.project("linear:bot")?.accountID == "mac-claude")
        (c.projectSlug, c.projectName) = ("bot", "AI Trading Bot")
        check("going back to a project brings back its account", store.adopt(into: &c) && c.accountID == "mac-claude" && c.worker == .claude)
        check("and its repo", c.repo == "acme/bot")
        store.sync(c)
        check("the store remembers which project runs", store.activeProject == "linear:bot" && store.projects.count == 2)

        // Clearing.
        var cleared = store
        cleared.remove(work.id)
        check("clearing an account forgets only it", cleared.account("w1") == nil && cleared.account("mac-claude") != nil)
        check("a project that used it needs another account", cleared.project("linear:site")?.accountID == nil)
        check("Forge only removes folders it made", AccountClear.ownFolder(work) != nil && carried.flatMap(AccountClear.ownFolder) == nil)
        var escape = work
        escape.folder = "../../Documents"
        check("a folder outside Forge's accounts folder is never removed", AccountClear.ownFolder(escape) == nil)
        check("a name already taken gets a number", store.freeName(.claude, "Work") == "Work 2" && store.freeName(.claude, " ") == "Claude Code")
        check("a carried-over account gets its own folder before signing in again", carried?.preparedForSignIn().folder == "mac-claude")
    }

    /// `Forge --accounts-check`: the same flow against a real Keychain and folders, run only with a scratch
    /// `FORGE_HOME` and `FORGE_KEYCHAIN_SERVICE` (and `FORGE_KEYCHAIN_PATH` in a sandboxed shell), so it never
    /// touches the person's own. Carries over the scratch setup.json, adds two Claude Code accounts, switches,
    /// clears one, and checks the other is untouched.
    static func accountsLive() -> Int32 {
        let env = ProcessInfo.processInfo.environment
        guard env["FORGE_HOME"] != nil, let service = env["FORGE_KEYCHAIN_SERVICE"], service != Keychain.service else {
            print("✗ set FORGE_HOME and FORGE_KEYCHAIN_SERVICE to scratch values first")
            return 2
        }
        var failed = 0
        func check(_ name: String, _ ok: Bool) {
            print("\(ok ? "✓" : "✗") \(name)")
            if !ok { failed += 1 }
        }
        var c = SetupChoices.load()
        var store = SetupStore.load(migrating: &c)
        check("the store was written next to setup.json", FileManager.default.fileExists(atPath: SetupStore.file.path))
        check("setup.json now names the carried-over account", SetupChoices.load().accountID == c.accountID && c.accountID != nil)
        let personal = AIAccount.new(.claude, method: .browser, name: store.freeName(.claude, "Personal"))
        let work = AIAccount.new(.claude, method: .browser, name: store.freeName(.claude, "Work"))
        for (a, token) in [(personal, "sk-ant-oat01-personal-test"), (work, "sk-ant-oat01-work-test")] {
            _ = Keychain.set(token, named: a.secretItem ?? "")
            try? FileManager.default.createDirectory(at: a.folderURL!, withIntermediateDirectories: true)
            store.put(a)
        }
        (c.accountID, c.worker) = (work.id, work.worker)
        store.sync(c)
        store.save()
        let saved = SetupStore.saved(for: c)
        check("both accounts are saved", saved.account(personal.id) != nil && saved.account(work.id) != nil)
        check(
            "the project runs on the work account's own sign-in",
            saved.activeAccount(c).map { WorkerCheck.env($0, secret: WorkerCheck.secret($0)) } == [
                "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-work-test"
            ])
        Task.detached { await AccountClear.clear(work) }.waitBlocking()
        store.remove(work.id)
        check("clearing removes its sign-in from the Keychain", !Keychain.has(named: work.secretItem ?? ""))
        check("and its login folder", !FileManager.default.fileExists(atPath: work.folderURL!.path))
        check("the other account keeps its sign-in", Keychain.get(named: personal.secretItem ?? "") == "sk-ant-oat01-personal-test")
        check("and its folder", FileManager.default.fileExists(atPath: personal.folderURL!.path))
        check("the project needs another account", store.project(SetupStore.projectID(c))?.accountID == nil)
        Task.detached { await AccountClear.clear(personal) }.waitBlocking()
        print(failed == 0 ? "accounts-check: all passed" : "accounts-check: \(failed) failed")
        return failed == 0 ? 0 : 1
    }
}

extension Task where Failure == Never, Success == Void {
    /// Waits for the task from a command-line check (no run loop to return to).
    func waitBlocking() {
        let done = DispatchSemaphore(value: 0)
        Task<Void, Never>.detached {
            await self.value
            done.signal()
        }
        done.wait()
    }
}
