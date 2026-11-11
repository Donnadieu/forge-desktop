import AppKit
import SwiftUI

/// Headless checks the agent can run (it can't see the screen). Used by tools/preflight.sh and CI.
///   Forge --selftest            facts about the app + the main view draws
///   Forge --version             prints the version
///   Forge --window-check <file> opens normally, writes what windows it shows to <file>, quits
///   Forge --workspaces-check    opens a copy of Forge's folder (FORGE_HOME) and prints its workspaces after the upgrade
///   Forge --accounts-check      accounts against a scratch Keychain and folder (FORGE_HOME + FORGE_KEYCHAIN_SERVICE)
///   Forge --engine-check        starts the bundled engine in a scratch folder and proves start/watch/stop
///   Forge --icon-check          the app icon ships, and Finder and Stage Manager draw it (package-app.sh runs it)
///   Forge --basecamp-token      prints a fresh Basecamp token as one JSON line (for the engine; renews it);
///                               `--item <keychain item>` picks the connection
///   Forge --basecamp-sign-in    Basecamp's device sign-in without the window: prints the link and code, waits
///   Forge --github-token        prints the GitHub board sign-in's token as one JSON line (for the engine)
///   Forge --github-sign-in      GitHub's device sign-in for the board without the window
@MainActor
enum Checks {
    static func run(_ args: [String]) -> Int32? {
        if args.contains("--version") {
            print(AppInfo.version)
            return 0
        }
        if args.contains("--selftest") {
            return selftest()
        }
        if args.contains("--workspaces-check") {
            return workspacesLive()
        }
        if args.contains("--accounts-check") {
            return accountsLive()
        }
        if args.contains("--engine-check") {
            return EngineCheck.run()
        }
        if args.contains("--icon-check") {
            var failed = 0
            AppIcon.checks { name, ok in
                print("\(ok ? "✓" : "✗") \(name)")
                if !ok { failed += 1 }
            }
            return failed == 0 ? 0 : 1
        }
        // The tracker connection a token command is for (its Keychain item); without it, the one from before workspaces.
        if let i = args.firstIndex(of: "--item"), i + 1 < args.count, Checks.trackerItemAllowed(args[i + 1]) {
            BasecampLogin.item = args[i + 1]
            GitHubLogin.item = args[i + 1]
        }
        if args.contains("--basecamp-token") {
            return BasecampLogin.printToken()
        }
        if args.contains("--basecamp-sign-in") {
            return SetupApply.basecampSignIn()
        }
        if args.contains("--github-token") {
            return GitHubLogin.printToken()
        }
        if args.contains("--github-sign-in") {
            return SetupApply.githubSignIn()
        }
        if let i = args.firstIndex(of: "--apply-setup"), i + 1 < args.count {
            return SetupApply.run(args[i + 1])
        }
        if args.contains("--update-now") {
            return SetupProbe.updateNow()
        }
        if args.contains("--check-update") {
            return SetupProbe.checkUpdate()
        }
        if let i = args.firstIndex(of: "--worker-check"), i + 1 < args.count {
            return SetupProbe.worker(args[i + 1], model: i + 2 < args.count ? args[i + 2] : nil)
        }
        if let i = args.firstIndex(of: "--github-check") {
            return SetupProbe.github(repo: i + 1 < args.count ? args[i + 1] : nil)
        }
        if args.contains("--sessions-check") {
            return SessionsCheck.run()
        }
        if args.contains("--transcript-check") {
            return TranscriptCheck.run()
        }
        if let i = args.firstIndex(of: "--render-screens"), i + 1 < args.count {
            return ScreenRender.run(into: args[i + 1])
        }
        return nil
    }

    /// A token command may only read a tracker connection's item: one from before workspaces, or `tracker-…`.
    static func trackerItemAllowed(_ item: String) -> Bool {
        Tracker.allCases.map(TrackerItem.legacy).contains(item) || item.hasPrefix("tracker-")
    }

    static func selftest() -> Int32 {
        var failed = 0
        func check(_ name: String, _ ok: Bool) {
            print("\(ok ? "✓" : "✗") \(name)")
            if !ok { failed += 1 }
        }
        check("the app is called Forge", AppInfo.name == "Forge")
        check("the version comes from the bundle", AppInfo.version != "dev")
        check("the Forge fonts ship inside the app and load", Theme.fontsLoaded)
        AppIcon.checks(check)
        let renderer = ImageRenderer(content: RootView(model: AppModel(preview: true)).frame(width: 1200, height: 800))
        renderer.scale = 1
        let size = renderer.nsImage?.size ?? .zero
        check("the main window's view draws", size.width == 1200 && size.height == 800)
        boardFollowsSwitch(check)
        check("a Linear key problem offers the key screen", OrchestratorScreen.fix(for: "Linear didn't accept this key.")?.isLink == false)
        check("an unknown problem offers no button that can't fix it", OrchestratorScreen.fix(for: "Linear answered 502.") == nil)
        check("a Stop the engine took counts even when its answer was slow", BoardLink.landed(.stop, in: SampleBoard.stopping))
        check("a Stop that never reached the engine is noticed", !BoardLink.landed(.stop, in: SampleBoard.state))
        let notSent = BoardLink.didNotLand(.stop)
        check("a Stop that didn't go through says what to press, in plain words", notSent.contains("Press Stop again") && !notSent.contains("Error"))
        let timedOut = BoardLink.plain(URLError(.timedOut))
        check("the engine's raw network error never reaches the screen", !timedOut.contains("NSURLErrorDomain") && !timedOut.contains("-1001"))
        check(
            "a problem the app hit doesn't claim Forge retries it",
            OrchestratorScreen.noticeDetail(notSent, signedOutLine: nil, appProblem: notSent) == nil)
        check(
            "the engine's own problems still say Forge tries again",
            OrchestratorScreen.noticeDetail("Linear answered 502.", signedOutLine: nil, appProblem: nil) != nil)
        check("Linear's usage limit offers the Linear plan page", OrchestratorScreen.fix(for: "Linear said: usage limit exceeded")?.isLink == true)
        check("with QA off, cards go from AI Review to Human Review", Pipeline.skipTarget("QA", off: ["QA"]) == "Human Review")
        check("with QA and Human Review off, AI Review hands to Merging", Pipeline.skipTarget("QA", off: ["QA", "Human Review"]) == "Merging")
        check("stages that are off leave the agents' list", !Pipeline.activeColumns(off: ["QA"]).contains("QA"))
        check(
            "Todo, In Progress and Rework can't be turned off",
            Set(Pipeline.optionalColumns).isDisjoint(with: ["Todo", "In Progress", "Rework", "Backlog", "Done"]))
        check("with every stage on, the lead's instructions are unchanged", Pipeline.routingNote(off: []) == nil)
        check(
            "a stage that is off is named in the lead's instructions",
            Pipeline.routingNote(off: ["QA"])?.contains("move it to `Human Review` instead") == true)
        check("Codex on an OpenAI key keeps its key in the Keychain", WorkerCheck.keyItem(.codexKey) == .openaiKey)
        check("Claude Code signed in with the browser needs no key", WorkerCheck.keyItem(.claude) == nil)
        let older = #"{"worker":"apiKey","linearUser":"a","columnsReady":true,"repoChecked":true,"workerChecked":true}"#
        check(
            "settings saved by 0.2.4 still load, with every stage on",
            (try? JSONDecoder().decode(SetupChoices.self, from: Data(older.utf8))).map { $0.worker == .apiKey && $0.stagesOff == nil } == true)
        var moves = SetupChoices()
        check("by default Forge moves no cards out of Backlog", !EngineSettings.frontMatter(moves, cardsFolder: "/c").contains("promote:"))
        (moves.sendNewToTriage, moves.startReady) = (true, true)
        let both = EngineSettings.frontMatter(moves, cardsFolder: "/c")
        check(
            "both Backlog switches reach the engine, inside the tracker block",
            both.contains("  promote:\n    backlog_to_triage: true\n    ready_to_todo: true\nboard:"))
        moves.stagesOff = ["Triage"]
        check(
            "with Triage off, new cards stay in Backlog",
            EngineSettings.promoteLines(moves) == ["  promote:", "    backlog_to_triage: false", "    ready_to_todo: true"])
        check(
            "older settings still load, with no Backlog moves",
            (try? JSONDecoder().decode(SetupChoices.self, from: Data(older.utf8))).map { $0.sendNewToTriage == nil && $0.startReady == nil } == true)
        check("every pipeline column is missing from an empty team", Pipeline.missing(existing: []).count == 10)
        check(
            "a new Linear team misses six columns (Triage, AI Review, QA, Human Review, Rework, Merging)",
            Pipeline.missing(existing: ["Backlog", "Todo", "In Progress", "Done", "Canceled"]).map(\.name)
                == ["Triage", "AI Review", "QA", "Human Review", "Rework", "Merging"])
        check("column names match whatever their case and spacing", Pipeline.missing(existing: Pipeline.names.map { $0.uppercased() }).isEmpty)
        check("setup starts at the first screen (where the cards live)", SetupChoices().nextScreen == 0)
        var almost = SetupChoices()
        (almost.linearUser, almost.projectSlug, almost.columnsReady) = ("a", "p", true)
        (almost.githubLogin, almost.signing, almost.repo, almost.repoChecked) = ("g", .unsigned, "o/r", true)
        (almost.worker, almost.workerChecked) = (.claude, true)
        check("a setup saved before the Ready screen existed opens on it", almost.nextScreen == 5)
        almost.repoReady = true
        check("after Ready (or Skip) Forge opens on the board", almost.nextScreen == AppModel.boardScreen)
        let oldFile = #"{"linearUser":"a","columnsReady":true,"repoChecked":true,"workerChecked":true}"#
        check("settings saved by 0.1.x still load", (try? JSONDecoder().decode(SetupChoices.self, from: Data(oldFile.utf8)))?.linearUser == "a")
        let answer =
            "Here's what I found.\n```json\n{\"summary\":[\"Small app.\"],\"guardrails\":[{\"id\":\"lint\",\"title\":\"Linter\",\"why\":\"Catches mistakes.\"}]}\n```"
        check("the agent's guardrail list is read from its answer", RepoReader.parse(answer)?.guardrails.first?.id == "lint")
        check("an answer without the list is refused", RepoReader.parse("All good!") == nil)
        check(
            "an expired Claude sign-in is read as signed out",
            AgentSignIn.looksSignedOut("Claude Code said: Failed to authenticate: OAuth session expired and could not be refreshed"))
        check("a missing program is not read as signed out", !AgentSignIn.looksSignedOut("Claude Code isn't installed on this Mac."))
        check("Claude Code signs in with a long-lived token", AgentSignIn.command(for: .claude) == ["claude", "setup-token"])
        let tokenScreen =
            "\u{1B}[32m✓\u{1B}[39m Long-lived authentication token created successfully!\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\n\u{1B}[1msk-ant-oat01-AbC_d-123456789012345678901234567890\u{1B}[22m\r\n\r\nStore this token securely."
        check(
            "the sign-in's token is read through terminal codes",
            AgentSignIn.token(in: tokenScreen) == "sk-ant-oat01-AbC_d-123456789012345678901234567890")
        check("no token before the person approves", AgentSignIn.token(in: "Opening browser to sign in…\r\nPaste code here if prompted > ") == nil)
        let glued =
            "Your OAuth token (valid for 1 year):\u{1B}[2B\u{1B}[1Gsk-ant-oat01-AbC_d-123456789012345678901234567890\u{1B}[2B\u{1B}[1GStore this token securely."
        check(
            "a cursor move ends the token (0.2.7 glued \"Store\" on)",
            AgentSignIn.token(in: glued) == "sk-ant-oat01-AbC_d-123456789012345678901234567890")
        check("half a token read mid-print doesn't count", AgentSignIn.token(in: "sk-ant-oat01-AbC_d-1234567890123456789012") == nil)
        check(
            "a token kept with \"Store\" stuck on is repaired",
            AgentSignIn.repaired("sk-ant-oat01-AbC_d-123456789012345678901234567890Store") == "sk-ant-oat01-AbC_d-123456789012345678901234567890")
        check(
            "a good token is left alone",
            AgentSignIn.repaired("sk-ant-oat01-AbC_d-123456789012345678901234567890") == "sk-ant-oat01-AbC_d-123456789012345678901234567890")
        check(
            "terminal codes come off, the text stays",
            AgentSignIn.plain("\u{1B}]8;;https://x.y\u{07}link\u{1B}]8;;\u{07} \u{1B}[1mhi\u{1B}[0m") == "link hi")
        let printed =
            "Opening browser to sign in… If the browser didn't open, visit: https://claude.ai/oauth/authorize?code=true&x=1 Paste code here if prompted > "
        let scanned = AgentSignIn.scan(printed)
        check("the sign-in link is read from what Claude Code prints", scanned.link?.host == "claude.ai")
        check("the paste-a-code prompt is noticed", scanned.wantsCode)
        check("1.2.10 is newer than 1.2.9", Updater.newer("1.2.10", than: "1.2.9"))
        check("1.0 is not newer than 1.0.0", !Updater.newer("1.0", than: "1.0.0"))
        check("0.9.9 is not newer than 1.0.0", !Updater.newer("0.9.9", than: "1.0.0"))
        let expired = #"{"type":"result","is_error":true,"result":"Failed to authenticate: OAuth session expired"}"#
        check(
            "a Claude login that exits 0 but can't answer fails the check",
            WorkerCheck.claudeOutcome(.init(status: 0, out: expired, err: ""))
                == .fails("Claude Code said: Failed to authenticate: OAuth session expired"))
        let answered = #"{"type":"result","is_error":false,"result":"ready"}"#
        check("a Claude answer passes the check", WorkerCheck.claudeOutcome(.init(status: 0, out: answered, err: "")) == .works)
        let codexOK = #"{"type":"item.completed","item":{"type":"agent_message","text":"ready"}}"#
        check("a Codex answer passes the check", WorkerCheck.codexOutcome(.init(status: 0, out: codexOK, err: "")) == .works)
        let codexBad = #"{"type":"turn.failed","error":{"message":"unauthorized"}}"#
        check(
            "a failed Codex turn fails the check",
            WorkerCheck.codexOutcome(.init(status: 1, out: codexBad, err: "")) == .fails("Codex said: unauthorized"))
        harnessChecks(check)
        trackerChecks(check)
        linearTeamChecks(check)
        missingColumnSetupChecks(check)
        missingColumnStudioChecks(check)
        missingColumnGatingChecks(check)
        parkingChecks(check)
        nextStepChecks(check)
        skillChecks(check)
        workspaceNameChecks(check)
        moveChecks(check)
        accountChecks(check)
        workspaceChecks(check)
        workspaceDeleteChecks(check)
        workflowFileChecks(check)
        limitChecks(check)
        sessionChecks(check)
        sessionPolishChecks(check)
        sessionIsolationChecks(check)
        print(failed == 0 ? "selftest: all passed" : "selftest: \(failed) failed")
        return failed == 0 ? 0 : 1
    }
}

/// Proves the real app opens a window titled Forge. Runs inside a normal launch.
@MainActor
enum WindowCheck {
    static func startIfAsked(_ args: [String]) {
        guard let i = args.firstIndex(of: "--window-check"), i + 1 < args.count else { return }
        let out = args[i + 1]
        // A check launch stays out of the person's way: no Dock icon, no focus, see-through window.
        NSApp.setActivationPolicy(.accessory)
        NotificationCenter.default.addObserver(forName: NSWindow.didUpdateNotification, object: nil, queue: .main) { note in
            (note.object as? NSWindow)?.alphaValue = 0
        }
        let activity = ProcessInfo.processInfo.beginActivity(options: .userInitiated, reason: "window check")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            let titles = NSApp.windows.map(\.title).filter { !$0.isEmpty }
            let line = titles.contains(AppInfo.name) ? "ok \(titles)" : "fail \(titles)"
            try? line.write(toFile: out, atomically: true, encoding: .utf8)
            ProcessInfo.processInfo.endActivity(activity)
            AppDelegate.quitSoon()
        }
    }
}
