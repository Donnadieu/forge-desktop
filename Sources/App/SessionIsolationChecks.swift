import AppKit
import SwiftUI

/// Selftest checks that a workspace's Sessions screen shows and acts on only its own sessions: the list, the open
/// session with its tabs and Changes panel, the side-by-side chat, steering and Stop, ⌘⌥L, notifications and the
/// Orchestrator's Open session. A card running in another workspace keeps running; it just isn't shown here.
@MainActor
extension Checks {
    final class Calls { var steered: [String] = [], wheel: [String] = [] }

    static func sessionIsolationChecks(_ check: (String, Bool) -> Void) {
        let model = AppModel(preview: true, screen: AppModel.sessionsScreen)
        let s = model.sessions
        guard let a = model.workspace?.id, let project = model.store.projects(in: a).first?.id else {
            return check("the sample workspace has a project", false)
        }
        let b = model.store.addWorkspace(name: "Intake Tool", color: "green").id
        let cardID = AppModel.cardSessionID(project: project, card: "atc-1742")
        var card = SampleSessions.session(
            cardID, "ATC-1742 Serve Directory → Talent from cached talent rows", repo: "andela-technology/andela",
            branch: "serve-directory-talent-from-cached-talent-rows-atc-1742", status: "working", origin: "card",
            chats: [SampleSessions.chat("ca", cardID, "ATC-1742", state: "working")])
        var waiting = SampleSessions.session(
            "a2", "Andela question", repo: "andela-technology/andela", branch: "omar/question", status: "needs_you",
            chats: [SampleSessions.chat("cq", "a2", "Chat", state: "needs_you")])
        var intake = SampleSessions.session(
            "i1", "PER-32 Get the intake repo ready", repo: "Donnadieu/intake-workspace", branch: "per-32", status: "idle",
            origin: "card", chats: [SampleSessions.chat("ci", "i1", "PER-32")])
        (card.workspaceId, waiting.workspaceId, intake.workspaceId) = (a, a, b)
        s.sessions = [card, waiting, intake]
        s.cardTargets = [cardID: CardTarget(project: project, card: "atc-1742")]
        s.changes[cardID] = [Sessions.FileChange(path: "app/models/talent.rb", added: 12, removed: 3, status: "M")]
        let calls = Calls()
        s.steerCard = { _, c, _ in
            calls.steered.append(c)
            return nil
        }
        s.cardWheel = { _, c, _ in
            calls.wheel.append(c)
            return nil
        }

        // Workspace A: the running card is open, with A's other session beside it.
        s.open(card)
        s.splitChat = "cq"
        let window = offscreen(SessionsScreen(model: model, sessions: s))
        defer { window.orderOut(nil) }
        settle()
        check("isolation: A's card session is open in A", s.current?.id == cardID)

        // Switch to B: nothing of A's shows, and nothing done here reaches A's card.
        Task { await model.open(workspace: b) }
        settle()
        check("isolation: B's list has no A sessions", s.sessions(in: model.workspace?.id).map(\.id) == ["i1"])
        check("isolation: B doesn't open A's session", s.current.map { $0.workspaceId == b } ?? true)
        check("isolation: B's side-by-side chat isn't A's", s.chat(s.splitChat).flatMap(s.session(of:)).map { $0.workspaceId == b } ?? true)
        // The chat, its tabs, the steer box, Skills and the Changes panel all draw `current` (SessionsScreen.swift).
        check("isolation: B's chat, tabs and Changes panel have no A session to draw", s.current?.workspaceId != a)
        if let chat = s.sessions.first(where: { $0.id == cardID })?.chats.first {
            s.send(chat, text: "steer from B", queue: false)
            s.wheel(chat, take: true)
        }
        settle()
        check("isolation: steering from B can't reach A's card", calls.steered.isEmpty)
        check("isolation: Stop from B can't take A's card", calls.wheel.isEmpty)
        s.openNextNeedingYou()
        check("isolation: ⌘⌥L stays inside B", s.current.map { $0.workspaceId == b } ?? true)
        check("isolation: History in B has no A sessions", s.archived(in: b).allSatisfy { $0.workspaceId == b })

        // Each workspace keeps its own pick: B opens its own session, A gets its card back, B gets its own again.
        s.open(intake)
        Task { await model.open(workspace: a) }
        settle()
        check("isolation: back in A, A's card session is open again", s.current?.id == cardID)
        check("isolation: and A's side-by-side chat is back", s.splitChat == "cq")
        Task { await model.open(workspace: b) }
        settle()
        check("isolation: back in B, B's own session is open", s.current?.id == "i1")

        // A notification or the Orchestrator's Open session for A's card opens A first, never shows it inside B.
        LimitNotifier.shared.openSession?(cardID)
        settle()
        check("isolation: a notification for A's session opens it in A", model.workspace?.id == a && s.current?.id == cardID)
        Task { await model.open(workspace: b) }
        settle()
        if let state = try? EngineState.decode(Data(Self.runningCardFrame.utf8)), let c = state.cards.first {
            model.openCardSession(project: project, card: c)
            settle()
            check("isolation: Open session on A's card opens it in A", model.workspace?.id == a && s.current?.id == cardID)
        } else {
            check("isolation: the sample running card decodes", false)
        }
    }

    static let runningCardFrame = #"""
        {"status":"running","running":[],"board":{"columns":[{"name":"In Progress","cards":[
        {"id":"atc-1742","identifier":"ATC-1742","title":"Serve Directory","state":"In Progress","helpers":[],
         "agent":{"started_at":"2026-11-11T12:00:00Z","turn":3,"attempt":1,"session_id":"s-1","folder":"/tmp/w/ATC-1742"}}]}]}}
        """#
}
