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
        check("the token command is this app with --basecamp-token", EngineSettings.basecampTokenCommand.hasSuffix(",\"--basecamp-token\"]"))

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
        check(
            "a lapsed Basecamp sign-in offers the sign-in again",
            OrchestratorScreen.fix(for: "Forge couldn't read the board from Basecamp: Basecamp sign-in needed: refresh failed")?.title
                == "Sign in to Basecamp again")
    }
}
