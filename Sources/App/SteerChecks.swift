import AppKit
import SwiftUI

/// Selftest checks that every message the person sends shows as their own bubble at once: a steer with its
/// "sending" / "delivered" state, a message queued for after the turn, and a steer that became a turn of its own
/// leaving the turn it was first shown in (Omar's ATC-1742 steer, Nov 11).
@MainActor
extension Checks {
    static func steerChecks(_ check: (String, Bool) -> Void) {
        let frame =
            #"{"type":"chat","chat":{"id":"c","sessionId":"s","title":"Chat","model":"opus","effort":"high","planMode":false,"askBeforeChanges":false,"state":"working","contextTokens":0,"contextWindow":200000},"queued":2,"queue":["one","two"]}"#
        if case .chat(let c)? = Sessions.decodeFrame(Data(frame.utf8)) {
            check("a chat frame brings its queued messages, in order", c.queue == ["one", "two"] && c.queued == 2)
        } else {
            check("a chat frame brings its queued messages, in order", false)
        }
        let event =
            #"{"type":"event","event":{"id":"e","chatId":"c","turnId":"t","seq":3,"kind":"user","text":"Why?","name":"steered","data":{"delivery":"delivered"},"size":4,"ref":null,"isError":false}}"#
        if case .event(let e)? = Sessions.decodeFrame(Data(event.utf8)) {
            check("a steer event says it was delivered", e.delivery == "delivered" && e.name == "steered")
        } else {
            check("a steer event says it was delivered", false)
        }
        let old = SampleSessions.event("k3", "t4", "c4", "user", "Older steer", name: "steered")
        check("a steer recorded before delivery states shows none", old.delivery == nil)

        let turn = SampleSessions.steerTurn(delivery: "sending")
        let mine = turn.events.firstIndex { $0.name == "steered" }
        let reply = turn.events.firstIndex { $0.text.hasPrefix("Good catch") }
        if let mine, let reply {
            check("the person's steer shows before the agent's reply", mine < reply)
        } else {
            check("the person's steer shows before the agent's reply", false)
        }
        let t = Transcript(chatID: "c4", turns: [turn])
        if let e = turn.events.first(where: { $0.name == "steered" }) {
            var dropped = e
            dropped.kind = "dropped"
            t.apply(dropped)
        }
        check("a steer that became its own turn leaves the turn it was shown in", t.turns.first?.events.contains { $0.name == "steered" } == false)

        let bubble = NSHostingController(rootView: SteerBubble(text: "Why do we have 17961 files changed?", delivery: "sending").frame(width: 600))
        check("the steer bubble with its state fits a chat column", bubble.sizeThatFits(in: CGSize(width: 600, height: 400)).width <= 600)
    }
}
