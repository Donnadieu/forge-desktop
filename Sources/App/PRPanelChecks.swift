import AppKit
import SwiftUI

/// Selftest checks for the sidebars, the Changes panel's one status and button, the branch in the header and
/// archiving from the list (docs/design/sidebar-pr-panel.md, Direction A).
@MainActor
extension Checks {
    static func prPanelChecks(_ check: (String, Bool) -> Void) {
        // What the sessions host sends for a pull request (engine sessions/github.ts `mergeStatus`).
        let frame = #"""
            {"pr":{"id":"PR_1","number":1288,"title":"Serve Directory","state":"OPEN","url":"https://github.com/a/b/pull/1288",
            "isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"BEHIND","reviewDecision":"","changesRequestedBy":[],
            "base":"main","headOid":"abc","unresolved":2,"threadsByPath":{"app/jobs/x.rb":2},
            "checks":[{"name":"app","state":"FAILURE","url":"https://ci/app","required":true},{"name":"lint","state":"SUCCESS","url":"","required":false}],
            "status":{"tone":"blocked","label":"Branch is behind main","action":"update"}}}
            """#
        let pr = try? JSONDecoder().decode(SessionsClient.PR.self, from: Data(frame.utf8)).pr
        check("a pull request brings its one status from GitHub", pr?.status?.label == "Branch is behind main" && pr?.status?.action == "update")
        check("a pull request brings its review comments per file", pr?.comments(on: "app/jobs/x.rb") == 2 && pr?.comments(on: "other.rb") == 0)
        check("a failing check keeps its log link", pr?.failing.first?.url == "https://ci/app")
        let old = #"{"pr":{"number":3,"title":"t","state":"OPEN","url":"u","isDraft":false,"checks":[{"name":"a","state":"SUCCESS"}]}}"#
        check(
            "a pull request from an older host still reads", (try? JSONDecoder().decode(SessionsClient.PR.self, from: Data(old.utf8)).pr?.number) == 3
        )

        let titles = ["merge", "resolve", "update", "view_checks", "pull_comments", "ready_for_review", "open"].map { PRAction(rawValue: $0)?.title }
        check(
            "each status has its one button",
            titles == ["Merge", "Resolve", "Update", "View", "Pull into chat", "Ready for review", "View on GitHub"])
        check("a status with nothing to press shows no button", PRAction(rawValue: "") == nil)
        check("review comments show as a quiet line when something else blocks first", pr.map(ChangesPanel.quietComments) == 2)
        var commentsFirst = pr
        commentsFirst?.status = .init(tone: "blocked", label: "2 review comments", action: "pull_comments")
        check("review comments aren't shown twice when they're the button", commentsFirst.map(ChangesPanel.quietComments) == 0)

        check(
            "a file row shows its folder dimmed and its name",
            FileName.split("app/jobs/x.rb") == ("app/jobs/", "x.rb") && FileName.split("x.rb") == ("", "x.rb"))

        check("a draft PR asks the agent for a draft", Sessions.Prompt.createPR(base: "main", draft: true).contains("--draft"))
        check("a plain PR isn't a draft", !Sessions.Prompt.createPR(base: "main").contains("--draft"))
        check("Resolve asks the agent to merge the base in", Sessions.Prompt.resolveConflicts(base: "main").contains("origin/main"))

        check(
            "an answer that says no becomes the problem on screen",
            SessionsClient.refusal(Data(#"{"ok":false,"problem":"GitHub refused."}"#.utf8)) == "GitHub refused.")
        check("an answer that says yes is no problem", SessionsClient.refusal(Data(#"{"ok":true}"#.utf8)) == nil)

        sidebarLayoutChecks(check)
        branchAndArchiveChecks(check)
    }

    static func sidebarLayoutChecks(_ check: (String, Bool) -> Void) {
        let wide = SessionsLayout.fit(total: 1440, left: 260, right: 360, leftOpen: true, rightOpen: true)
        check("a wide window shows both sidebars", wide.left == 260 && wide.right == 360)
        let mid = SessionsLayout.fit(total: 1000, left: 260, right: 360, leftOpen: true, rightOpen: true)
        check("a narrower window closes the Changes panel first", mid.left == 260 && mid.right == nil)
        let small = SessionsLayout.fit(total: 700, left: 260, right: 360, leftOpen: true, rightOpen: true)
        check("then the sessions list, so the chat keeps its room", small.left == nil && small.right == nil)
        let shut = SessionsLayout.fit(total: 1440, left: 260, right: 360, leftOpen: false, rightOpen: true)
        check("a closed sidebar stays closed", shut.left == nil && shut.right == 360)
        check("dragging under the narrowest width closes the sidebar", SessionsLayout.drag(140, side: .left) == nil)
        check("dragging past the widest stops there", SessionsLayout.drag(900, side: .right) == SessionsLayout.changes.max)
        check("a drag in between keeps its width", SessionsLayout.drag(300, side: .left) == 300)
    }

    static func branchAndArchiveChecks(_ check: (String, Bool) -> Void) {
        var s = SampleSessions.session("b1", "Fix login", repo: "acme/app", branch: "omar/fix-login", status: "idle", chats: [])
        check("a session with no pull request can rename its branch", BranchMenu.renameBlock(s) == nil)
        s.prNumber = 12
        s.prState = "OPEN"
        check(
            "an open pull request keeps its branch's name, and says why",
            BranchMenu.renameBlock(s) == "GitHub closes the PR when its branch is renamed")
        var card = s
        card.origin = "card"
        card.prNumber = nil
        check("a card's branch can't be renamed here", BranchMenu.renameBlock(card) != nil)

        let model = SessionsModel(preview: true)
        let running = SampleSessions.session(
            "card-p-c1", "ATC-1730 Placement jobs close on fill", repo: "a/b", branch: "atc-1730", status: "working", chats: [])
        var cardSession = running
        cardSession.origin = "card"
        model.cardTargets = ["card-p-c1": CardTarget(project: "p", card: "c1")]
        check("archiving a running card asks once", model.archiveQuestion(cardSession)?.title == "Archive ATC-1730?")
        let idle = SampleSessions.session("i1", "Old spike", repo: "a/b", branch: "x", status: "idle", chats: [])
        check("archiving an idle session doesn't ask", model.archiveQuestion(idle) == nil)

        var list = SampleSessions.all
        var archived: [Sessions.Session] = []
        for n in 0..<25 {
            var a = SampleSessions.session("old\(n)", "Old \(n)", repo: "a/b", branch: "x\(n)", status: "archived", chats: [])
            a.archived = true
            a.updatedAt = String(format: "2026-11-%02dT10:00:00Z", n + 1)
            archived.append(a)
        }
        list.append(contentsOf: archived)
        let folded = SessionList.sections(list.filter { !$0.archived }, archived: archived, folded: model.foldedGroups, search: "", selected: nil)
        check(
            "archived sessions sit in their own group at the end, folded, with their count",
            folded.last?.title == "Archived" && folded.last?.count == 25 && folded.last?.rows.isEmpty == true)
        model.toggleGroup("Archived")
        let open = SessionList.sections(list.filter { !$0.archived }, archived: archived, folded: model.foldedGroups, search: "", selected: nil)
        check("the open Archived group lists the newest 20", open.last?.rows.count == 20 && open.last?.rows.first?.id == "old24")
    }
}
