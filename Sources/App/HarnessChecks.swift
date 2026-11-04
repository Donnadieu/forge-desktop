import Foundation

extension Checks {
    /// Rules for the setup timeline's two modes and the per-repo harness engineering record.
    static func harnessChecks(_ check: (String, Bool) -> Void) {
        check("the first run lists every step and ends on the Orchestrator", AppModel.listedSteps(changing: false) == Array(0...6))
        check(
            "changing from Settings lists only the steps that can change (no Orchestrator)",
            AppModel.listedSteps(changing: true) == Array(0...5))
        let opened = AppModel(preview: true, screen: 3)
        check("setup opened on its own is the first run", !opened.changing)
        opened.change(1)
        check("a step opened from Settings is in changing mode", opened.changing && opened.screen == 1)
        opened.change(4)
        check("changing, any step opens from the list and Continue still returns to Settings", opened.screen == 4 && opened.returnTo == 8)
        check("changing the repo from Settings offers harness engineering", AppModel.afterRepo(changing: true, old: "a/x", new: "a/y") == 5)
        check("keeping the same repo goes back to Settings", AppModel.afterRepo(changing: true, old: "a/x", new: "a/x") == nil)
        check("the first run walks on from the repo as before", AppModel.afterRepo(changing: false, old: nil, new: "a/x") == nil)

        let g = { (id: String, rec: Bool) in HarnessGuardrail(id: id, title: id, why: "", recommended: rec) }
        let proposed = [g("lint", true), g("agents", true), g("layers", false)]
        check("a repo with no record is not started", HarnessRecord().status == .notStarted)
        check("a repo that was read is partly done", HarnessRecord(assessed: true, proposed: proposed).status == .partly)
        var r = HarnessRecord(assessed: true, proposed: proposed)
        r.sent(card: "ENG-1", url: "u", picked: ["lint"])
        check("a guardrail in an open card can't be picked again", r.item("lint") == .inCard && r.left.map(\.id) == ["agents", "layers"])
        r.landed(pr: 7)
        check("a merged pull request lands its guardrails", r.item("lint") == .done && r.applied == ["lint"] && r.status == .partly)
        r.sent(card: "ENG-2", url: "u", picked: ["agents"])
        r.landed(pr: 9)
        check("every recommended guardrail landed means done", r.status == .done && r.left.map(\.id) == ["layers"])
        var closed = HarnessRecord(assessed: true, proposed: proposed)
        closed.sent(card: "ENG-3", url: "u", picked: ["lint"])
        closed.closed(pr: 4)
        check("a closed pull request frees its guardrails", closed.item("lint") == .open)
        check("a merged ready-for-agents pull request found in the repo means done", HarnessRecord(pr: 3, merged: true).status == .done)
        check("an agent guide found in the repo means partly done", HarnessRecord(found: ["an agent guide (AGENTS.md)"]).status == .partly)
        check(
            "the repo's top folder shows an agent guide and a pre-commit hook",
            HarnessCheck.found(["AGENTS.md", ".githooks", "src"]) == ["an agent guide (AGENTS.md)", "a pre-commit hook"])
        let prs = [
            HarnessCheck.PullRequest(number: 2, state: "OPEN", title: "Other", headRefName: "sam/eng-20-other"),
            HarnessCheck.PullRequest(number: 5, state: "MERGED", title: "Guardrails", headRefName: "sam/eng-2-get-ready"),
        ]
        check("the card's pull request is found by its branch", HarnessCheck.match(card: "ENG-2", in: prs)?.number == 5)

        var c = SetupChoices()
        (c.linearUser, c.repo, c.repoChecked) = ("a", "o/r", true)
        check("a done step shows a check when changing", StepRow.badge(step: 0, choices: c) == .check)
        check("a step that isn't done shows the empty circle", StepRow.badge(step: 4, choices: c) == .notDone)
        check("harness engineering not started shows the empty circle", StepRow.badge(step: 5, choices: c) == .notDone)
        c.setHarness(HarnessRecord(assessed: true), for: "o/r")
        check("harness engineering partly done shows the half circle", StepRow.badge(step: 5, choices: c) == .half)
        c.setHarness(HarnessRecord(pr: 1, merged: true), for: "o/r")
        check("harness engineering done shows the check", StepRow.badge(step: 5, choices: c) == .check && c.stepDone(5))
        c.repo = "o/other"
        check("the harness record is kept per repo", StepRow.badge(step: 5, choices: c) == .notDone)
        check("the Settings tile offers Start, Run again or Change", SettingsScreen.harnessAction(.partly) == "Run again")

        let v025 = #"{"linearUser":"a","columnsReady":true,"repoChecked":true,"workerChecked":true,"repoReady":true,"stagesOff":["QA"]}"#
        check(
            "settings saved by 0.2.5 still load, with no harness record",
            (try? JSONDecoder().decode(SetupChoices.self, from: Data(v025.utf8))).map { $0.harness == nil && $0.stagesOff == ["QA"] } == true)
        let withRecord =
            #"{"columnsReady":true,"repoChecked":true,"workerChecked":true,"repo":"o/r","harness":{"o/r":{"assessed":true,"card":"ENG-1"}}}"#
        check(
            "a saved harness record loads back",
            (try? JSONDecoder().decode(SetupChoices.self, from: Data(withRecord.utf8)))?.harnessHere.card == "ENG-1")
    }

    /// Rules for the cards a person moves from the Orchestrator.
    static func moveChecks(_ check: (String, Bool) -> Void) {
        let moves = SampleBoard.moves.cards
        let ready = moves.filter(CardMoves.isReady)
        check("only cards triage marked ready show Start", ready.map(\.identifier) == ["AIT-17", "AIT-18"])
        check(
            "a blocked Todo card says what it waits on",
            moves.first { $0.identifier == "AIT-16" }.flatMap(CardMoves.waitingLine) == "Waiting on AIT-15")
        check("a card with nothing blocking it says nothing", moves.first { $0.identifier == "AIT-17" }.flatMap(CardMoves.waitingLine) == nil)
        check("a bulk button needs two cards or more", CardMoves.showsBulk(ready) && !CardMoves.showsBulk(Array(ready.prefix(1))))
        let merge = BulkMove(kind: .merge, cards: moves.filter { $0.state == "Human Review" })
        check(
            "Merge all moves the pull requests to Merging",
            merge.to == "Merging" && merge.title == "Merge 3 pull requests?" && merge.button == "Merge all")
        let start = BulkMove(kind: .start, cards: ready)
        check("Start all moves the ready cards to Todo", start.to == "Todo" && start.title == "Start 2 cards?" && start.button == "Start all")
        let old =
            #"{"status":"running","running":[],"board":{"columns":[{"name":"Todo","cards":[{"id":"1","identifier":"A-1","title":"t","state":"Todo","helpers":[]}]}],"read_at":null,"problem":null}}"#
        let decoded = try? EngineState.decode(Data(old.utf8))
        check("a board from an engine without labels still loads", decoded?.cards.first?.labels == nil && decoded?.cards.count == 1)
    }
}
