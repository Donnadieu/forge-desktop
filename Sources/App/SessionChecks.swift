import Foundation

/// Selftest checks for card sessions: the board's running cards become sessions the host follows, with the same id
/// the engine gives them (engine sessions/cards.ts), and a message on one goes to the card's engine.
@MainActor
extension Checks {
    static func sessionChecks(_ check: (String, Bool) -> Void) {
        check(
            "a card's session id matches the engine's",
            AppModel.cardSessionID(project: "linear:proj-1", card: "abc-1") == "card-linear-proj-1-abc-1")
        let frame = #"""
            {"status":"running","running":[],"board":{"columns":[{"name":"In Progress","cards":[
            {"id":"abc-1","identifier":"CE-142","title":"Fix the invoice total","state":"In Progress","branchName":"ce-142","helpers":[],
             "agent":{"started_at":"2026-11-09T12:00:00Z","turn":3,"attempt":1,"session_id":"s-1","folder":"/tmp/w/CE-142","hands_on":true}},
            {"id":"abc-2","identifier":"CE-143","title":"Waiting","state":"In Progress","helpers":[],
             "agent":{"started_at":"2026-11-09T12:00:00Z","turn":0,"attempt":1}}]}]}}
            """#
        let state = try? EngineState.decode(Data(frame.utf8))
        check("a running card's agent session and folder decode", state?.cards.first?.agent?.folder == "/tmp/w/CE-142")
        let model = AppModel(preview: true)
        model.states = ["linear:proj-1": state].compactMapValues { $0 }
        let cards = model.runningCardSessions
        check(
            "only cards whose agent has a session are followed",
            cards.count == 1 && cards.first?["sessionId"] == "s-1" && cards.first?["key"] == "linear:proj-1:abc-1")
        model.watchCardSessions()
        let target = model.sessions.cardTargets["card-linear-proj-1-abc-1"]
        check("a message on a card's session goes to that card's engine", target?.project == "linear:proj-1" && target?.card == "abc-1")
        check("a card the person took the wheel of shows Hand back", target?.handsOn == true)
        check("chats the person started don't go to a card", model.sessions.cardTargets["s1"] == nil)

        var w = Workspace(id: "w1", name: "Personal")
        w.repos = [SessionRepo(repo: "Donnadieu/forge-desktop", local: "/Users/x/Repos/forge-desktop", base: "main")]
        w.sessionModel = "opus[1m]"
        w.sessionEffort = "high"
        let round = (try? JSONEncoder().encode(w)).flatMap { try? JSONDecoder().decode(Workspace.self, from: $0) }
        check("a workspace keeps its session repos and the model new sessions start with", round == w)
        let old = #"{"id":"w0","name":"Old"}"#
        let before = try? JSONDecoder().decode(Workspace.self, from: Data(old.utf8))
        check("a workspace saved before sessions still opens, with no repos", before != nil && before?.repos == nil)

        let diff = "diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -10,3 +10,4 @@ func\n keep\n-old\n+new one\n+new two\n keep"
        let rows = DiffLines.lines(diff)
        check("diff rows carry the new file's line numbers", rows.map(\.number) == [nil, 10, nil, 11, 12, 13])
        let quote = DiffSheet.quote(path: "x", diff: diff, range: rows[3].id...rows[4].id, note: "Name these better ")
        check(
            "a comment on a range joins the message quoted with the file and lines",
            quote == "On `x` lines 11–12:\n> +new one\n> +new two\nName these better")
        let (words, paths, _) = MessageImages.split("Look at this\n[image: /tmp/a.png]")
        check("a message's pictures show apart from its words", words == "Look at this" && paths == ["/tmp/a.png"])
        model.sessions.drafts["c1"] = "First"
        model.sessions.addComment("On `x` line 3:\n> a\nWhy?", session: "s1")
        let c = model.sessions.sessions.first { $0.id == "s1" }.flatMap { model.sessions.activeChat(of: $0) }
        check(
            "a diff comment goes after what's already in the message box",
            c.map { model.sessions.drafts[$0.id] ?? "" }?.hasSuffix("\n\nOn `x` line 3:\n> a\nWhy?") == true)
    }
}
