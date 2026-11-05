import Foundation

extension ScreenRender {
    /// Setup 1 and 2 on Basecamp, and the Orchestrator on a Basecamp board.
    static func basecampShots() -> [Shot] {
        var signed = SetupChoices()
        signed.tracker = .basecamp
        signed.basecamp = BasecampBoard(accountID: "999", accountName: "Acme", personID: "50", personName: "Sam Rivera")
        var ready = signed
        ready.basecamp?.projectID = "101"
        ready.basecamp?.cardTableID = "201"
        (ready.projectName, ready.projectSlug, ready.columnsReady) = ("AI Trading Bot", "101", true)
        (ready.githubLogin, ready.signing, ready.repo, ready.repoChecked) = ("samrivera", .forgeKey, "acme/ai-trading-bot", true)
        (ready.worker, ready.workerChecked, ready.repoReady) = (.claude, true, true)
        return [
            Shot(name: "1-basecamp-sign-in", screen: 0, scene: "basecamp"),
            Shot(name: "1-basecamp-code", screen: 0, scene: "basecamp-code"),
            Shot(name: "1-basecamp-connected", screen: 0, choices: signed),
            Shot(name: "2-basecamp-project", screen: 1, choices: signed),
            Shot(name: "7-orchestrator-basecamp", screen: AppModel.boardScreen, choices: ready, engine: SampleBoard.state),
        ]
    }

    /// Setup 1 and 2 on GitHub Issues.
    static func githubShots() -> [Shot] {
        var signed = SetupChoices()
        signed.tracker = .github
        signed.githubBoard = GitHubBoard(login: "samrivera", name: "Sam Rivera")
        return [
            Shot(name: "1-github-sign-in", screen: 0, scene: "github"),
            Shot(name: "1-github-code", screen: 0, scene: "github-code"),
            Shot(name: "1-github-connected", screen: 0, choices: signed),
            Shot(name: "2-github-project", screen: 1, choices: signed),
            Shot(name: "2-github-automations", screen: 1, choices: signed, scene: "github-movers", height: 1000),
        ]
    }
}

extension Checks {
    /// Rules for where the cards live: Linear (as before) or Basecamp.
    static func trackerChecks(_ check: (String, Bool) -> Void) {
        let old = #"{"linearUser":"a","projectSlug":"p","columnsReady":true,"repoChecked":true,"workerChecked":true}"#
        let saved = try? JSONDecoder().decode(SetupChoices.self, from: Data(old.utf8))
        check("settings saved before Basecamp came still mean Linear", saved?.board == .linear && saved?.trackerUser == "a")

        var c = SetupChoices()
        c.tracker = .basecamp
        check("Basecamp chosen but not signed in stays on the first screen", c.nextScreen == 0)
        c.basecamp = BasecampBoard(accountID: "999", accountName: nil, personID: "50", personName: "Sam Rivera")
        check("signed in to Basecamp moves on to the project", c.nextScreen == 1 && c.trackerUser == "Sam Rivera")
        c.basecamp?.projectID = "42"
        c.basecamp?.cardTableID = "7"
        c.basecamp?.columns = Dictionary(uniqueKeysWithValues: Pipeline.names.enumerated().map { ($0.element, String(600 + $0.offset)) })
        (c.projectSlug, c.columnsReady) = ("42", true)
        let fm = EngineSettings.frontMatter(c, cardsFolder: "/c")
        check(
            "a Basecamp board names its account, person, card table and columns",
            fm.contains(
                "  kind: basecamp\n  project_slug: \"42\"\n  account_id: \"999\"\n  identity_id: \"50\"\n  card_table_id: \"7\"\n  columns:\n")
                && fm.contains("    \"Backlog\": \"600\"") && fm.contains("    \"Done\": \"609\""))
        check("a Basecamp board's workflow names no Linear project", !fm.contains("kind: linear"))
        var linear = SetupChoices()
        linear.projectSlug = "abc"
        check(
            "a Linear board's workflow is unchanged",
            EngineSettings.frontMatter(linear, cardsFolder: "/c").contains("  kind: linear\n  project_slug: \"abc\"\n"))

        let note = EngineSettings.boardNote(c, template: "p=@@PROJECT@@ t=@@CARD_TABLE@@ b=@@BACKLOG@@\n@@COLUMNS@@")
        check("the Basecamp note gets this board's ids", note?.hasPrefix("p=42 t=7 b=600\n  - Backlog: `600`") == true)
        check("a Linear board gets no Basecamp note", EngineSettings.boardNote(linear, template: "x") == nil)
        check(
            "the token command is this app with --basecamp-token and its connection",
            EngineSettings.basecampTokenCommand(item: "basecamp-login").hasSuffix(",\"--basecamp-token\",\"--item\",\"basecamp-login\"]"))

        let table = BasecampAPI.CardTable(
            id: 7, title: "Card Table",
            lists: [
                .init(id: 1, title: "triage", type: "Kanban::Triage"), .init(id: 2, title: "In  progress", type: nil),
                .init(id: 3, title: "Done", type: nil),
            ])
        check(
            "Basecamp columns match whatever their case and spacing",
            BasecampAPI.columnMap(table) == ["Triage": "1", "In Progress": "2", "Done": "3"])
        check(
            "a card's Markdown becomes the HTML Basecamp keeps",
            BasecampAPI.html("# Get ready\nWhy <now>\n- one\n- two\nEnd")
                == "<h1>Get ready</h1><div>Why &lt;now&gt;</div><ul><li>one</li><li>two</li></ul><div>End</div>")
        check(
            "the next page comes from Basecamp's Link header",
            BasecampAPI.nextLink("<https://x/y.json?page=2>; rel=\"next\"") == "https://x/y.json?page=2")
        let t = BasecampLogin.Tokens(accessToken: "a", refreshToken: "r", expiresAt: 0, resource: "urn:bc:account:6068025")
        check("the sign-in names its account", t.accountID == "6068025")
        let renewed = try? BasecampLogin.tokens(from: ["access_token": "b", "expires_in": 3600], keeping: t)
        check("a renewal that sends no new refresh token keeps the old one", renewed?.refreshToken == "r" && renewed?.resource == t.resource)
        githubChecks(check)
        check(
            "a lapsed Basecamp sign-in offers the sign-in again",
            OrchestratorScreen.fix(for: "Forge couldn't read the board from Basecamp: Basecamp sign-in needed: refresh failed")?.title
                == "Sign in to Basecamp again")
    }
}

extension Checks {
    /// Rules for a GitHub Issues board (a GitHub project's Status field gives the columns).
    static func githubChecks(_ check: (String, Bool) -> Void) {
        var c = SetupChoices()
        c.tracker = .github
        check("GitHub Issues chosen but not signed in stays on the first screen", c.nextScreen == 0)
        c.githubBoard = GitHubBoard(login: "samrivera", name: "Sam Rivera")
        check("signed in to GitHub moves on to the project", c.nextScreen == 1 && c.trackerUser == "Sam Rivera" && c.trackerOrg == "@samrivera")
        c.githubBoard?.projectID = "PVT_9"
        c.githubBoard?.statusFieldID = "PVTSSF_3"
        c.githubBoard?.issueRepo = "acme/app"
        c.githubBoard?.columns = Dictionary(uniqueKeysWithValues: Pipeline.names.enumerated().map { ($0.element, "o\($0.offset)") })
        (c.projectSlug, c.columnsReady) = ("PVT_9", true)
        let fm = EngineSettings.frontMatter(c, cardsFolder: "/c")
        check(
            "a GitHub board names its project, Status field and options",
            fm.contains("  kind: github\n  project_slug: \"PVT_9\"\n  status_field_id: \"PVTSSF_3\"\n  columns:\n")
                && fm.contains("    \"Backlog\": \"o0\"") && fm.contains("    \"Done\": \"o9\""))
        let note = EngineSettings.boardNote(c, template: "p=@@PROJECT@@ f=@@FIELD@@ r=@@REPO@@\n@@COLUMNS@@")
        check("the GitHub note gets this board's ids", note?.hasPrefix("p=PVT_9 f=PVTSSF_3 r=acme/app\n  - Backlog: `o0`") == true)
        check(
            "the GitHub token command is this app with --github-token and its connection",
            EngineSettings.githubTokenCommand(item: "tracker-github-1").hasSuffix(",\"--github-token\",\"--item\",\"tracker-github-1\"]"))
        let options = [GitHubProjectsAPI.Option(id: "a", name: "todo"), .init(id: "b", name: "In  progress"), .init(id: "c", name: "Done")]
        check(
            "Status options match whatever their case and spacing",
            GitHubProjectsAPI.columnMap(options) == ["Todo": "a", "In Progress": "b", "Done": "c"])
        let kept = GitHubProjectsAPI.optionsWith(
            [.init(id: "a", name: "Todo", color: "BLUE", description: "x"), .init(id: "z", name: "Someday")],
            adding: Pipeline.columns.filter { ["Backlog", "Rework"].contains($0.name) })
        check(
            "adding Status options keeps every existing option by its id, in pipeline order",
            kept.map { $0["name"] as? String ?? "" } == ["Backlog", "Todo", "Rework", "Someday"] && kept[1]["id"] as? String == "a"
                && kept[1]["color"] as? String == "BLUE" && kept[0]["id"] == nil && kept[2]["color"] as? String == "RED"
                && kept[3]["id"] as? String == "z")
        check(
            "GitHub automations that move cards are found when they're on",
            GitHubProjectsAPI.movers([
                ["name": "Item added to project", "enabled": true], ["name": "Item closed", "enabled": true],
                ["name": "Pull request linked to issue", "enabled": false],
            ]) == ["Item added to project"])
        let scoped = GitHubLogin.Tokens(accessToken: "t", scope: "project,read:org,repo")
        check("a sign-in with the project scope can use projects", scoped.canUseProjects)
        check("a sign-in without it can't", !GitHubLogin.Tokens(accessToken: "t", scope: "repo,read:org").canUseProjects)
        check(
            "a lapsed GitHub board sign-in offers the sign-in again",
            OrchestratorScreen.fix(for: "Forge couldn't read the board from GitHub: GitHub sign-in needed: refresh failed")?.title
                == "Sign in to GitHub again")
        check("a GitHub board opens cards on GitHub", Tracker.github.site == "GitHub" && Tracker.basecamp.site == "Basecamp")
    }
}
