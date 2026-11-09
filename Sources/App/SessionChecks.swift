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
             "agent":{"started_at":"2026-11-09T12:00:00Z","turn":3,"attempt":1,"session_id":"s-1","folder":"/tmp/w/CE-142"}},
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
    }
}
