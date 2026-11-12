import AppKit
import SwiftUI
import Vision

/// Selftest checks for a chat whose agent asks a multiple-choice question, with real mouse and key events in an
/// off-screen window (Omar's ATC-1742 "Chat 2", Nov 12). Chat 2 is a chat of his own inside a running card's session:
/// a message typed while the question waits answers it (with any options already picked), the options answer it,
/// Stop stops that chat (not the card), a message the agent couldn't read says Not delivered with Retry, and the
/// card's own chat still steers the card.
@MainActor
extension Checks {
    static let askedSplit = "How finely should I cut the work into commits?"
    static let askedDepth = "How deep should the green check go?"

    final class ChatCalls {
        var steered: [String] = []
        var wheel: [String] = []
        var sent: [String] = []
        var actions: [(chat: String, action: String, detail: [String: String])] = []
        func did(_ action: String) -> [[String: String]] { actions.filter { $0.action == action }.map(\.detail) }
    }

    struct QuestionScene {
        let model: SessionsModel
        let session: Sessions.Session
        let mine: Sessions.Chat
        let cards: Sessions.Chat
        let turn: Sessions.Turn
        let calls: ChatCalls
    }

    static func questionScene() -> QuestionScene {
        let m = SessionsModel(preview: true)
        let sid = AppModel.cardSessionID(project: "p1", card: "atc-1742")
        let cards = SampleSessions.chat("\(sid)-chat", sid, "ATC-1742", state: "working")
        let mine = SampleSessions.chat("chat2", sid, "Chat 2", state: "needs_you")
        let s = SampleSessions.session(
            sid, "ATC-1742 Serve Directory talent page from cached rows", repo: "andela-technology/andela",
            branch: "serve-directory-talent-from-cached-talent-rows-atc-1742", status: "needs_you", origin: "card", chats: [cards, mine])
        func q(_ text: String, _ options: [String]) -> JSONValue {
            .object(["question": .string(text), "options": .array(options.map { .object(["label": .string($0)]) })])
        }
        let asked = SampleSessions.event(
            "q1", "t2", "chat2", "question", "", name: "AskUserQuestion",
            data: .object([
                "requestId": .string("r1"),
                "input": .object([
                    "questions": .array([
                        q(askedSplit, ["One commit per layer", "Merge the shared-file splits"]),
                        q(askedDepth, ["Scoped: affected suites only", "HEAD only"]),
                    ])
                ]),
            ]))
        let unread = SampleSessions.event(
            "s9", "t2", "chat2", "user", "Does that breakdown do that?", name: "steered", data: .object(["delivery": .string("failed")]))
        let turn = SampleSessions.turn("t2", "chat2", "yes", status: "working", events: [asked, unread])
        m.sessions = [s]
        m.selected = sid
        m.activeChat[sid] = mine.id
        m.cardTargets = [sid: CardTarget(project: "p1", card: "atc-1742")]
        m.setTranscript(Transcript(chatID: mine.id, turns: [turn]))
        let calls = ChatCalls()
        m.steerCard = { _, c, _ in
            calls.steered.append(c)
            return nil
        }
        m.cardWheel = { _, c, _ in
            calls.wheel.append(c)
            return nil
        }
        m.onSend = { _, text, _, _ in calls.sent.append(text) }
        m.onAction = { chat, action, detail in calls.actions.append((chat, action, detail)) }
        return QuestionScene(model: m, session: s, mine: mine, cards: cards, turn: turn, calls: calls)
    }

    /// Draws a chat's turn and its message box in an off-screen, see-through window that can take the keyboard.
    static func questionWindow(_ sc: QuestionScene, chat: Sessions.Chat) -> NSWindow {
        let size = NSSize(width: 900, height: 900)
        let view = VStack(alignment: .leading, spacing: 16) {
            TurnView(sessions: sc.model, chat: chat, turn: sc.turn)
            Spacer()
            Composer(sessions: sc.model, session: sc.session, chat: chat)
        }
        .padding(20).frame(width: size.width, height: size.height).background(Theme.bg)
        let host = NSHostingView(rootView: view)
        host.frame = NSRect(origin: .zero, size: size)
        host.appearance = NSAppearance(named: .darkAqua)
        NSApplication.shared.setActivationPolicy(.prohibited)
        let window = KeyWindow(
            contentRect: NSRect(x: -20000, y: -20000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered,
            defer: false)
        window.alphaValue = 0
        window.contentView = host
        window.orderFrontRegardless()
        window.makeKey()
        settle()
        return window
    }

    /// The words on a window's view and where each sits (Vision on the drawn view: no accessibility needed).
    static func wordsOnScreen(_ window: NSWindow) -> [(text: String, at: NSPoint)] {
        guard let host = window.contentView, let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return [] }
        host.layoutSubtreeIfNeeded()
        host.cacheDisplay(in: host.bounds, to: rep)
        guard let image = rep.cgImage else { return [] }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        return (request.results ?? []).compactMap { r in
            guard let s = r.topCandidates(1).first?.string else { return nil }
            // Vision's box starts at the bottom left, like a window's own points.
            return (s, NSPoint(x: r.boundingBox.midX * host.bounds.width, y: r.boundingBox.midY * host.bounds.height))
        }
    }

    /// Where some words sit on the window, even when Vision reads them as part of a longer line.
    static func placeOf(_ words: String, in window: NSWindow) -> NSPoint? {
        guard let host = window.contentView, let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return nil }
        host.layoutSubtreeIfNeeded()
        host.cacheDisplay(in: host.bounds, to: rep)
        guard let image = rep.cgImage else { return nil }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        for r in request.results ?? [] {
            guard let c = r.topCandidates(1).first, let range = c.string.range(of: words),
                let box = try? c.boundingBox(for: range)?.boundingBox
            else { continue }
            return NSPoint(x: box.midX * host.bounds.width, y: box.midY * host.bounds.height)
        }
        return nil
    }

    /// Clicks the middle of the words shown on screen with a real mouse press and release. False when they aren't shown.
    @discardableResult
    static func clickWords(_ words: String, in window: NSWindow) -> Bool {
        guard let at = placeOf(words, in: window) else { return false }
        func mouse(_ type: NSEvent.EventType) -> NSEvent? {
            NSEvent.mouseEvent(
                with: type, location: at, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0)
        }
        // Releases other checks left in the queue would land here instead of this one.
        while NSApp.nextEvent(matching: [.leftMouseUp, .leftMouseDown], until: Date(), inMode: .default, dequeue: true) != nil {}
        if let down = mouse(.leftMouseDown), let up = mouse(.leftMouseUp) {
            // Something that tracks the press (selectable text) takes the release from the queue itself; a button
            // gets it next, from here.
            NSApp.postEvent(up, atStart: false)
            window.sendEvent(down)
            if let left = NSApp.nextEvent(matching: .leftMouseUp, until: Date(), inMode: .default, dequeue: true) { window.sendEvent(left) }
        }
        settle()
        return true
    }

    /// Types into the message box with real key events, then presses Enter.
    static func typeAndSend(_ text: String, in window: NSWindow) -> Bool {
        guard let host = window.contentView, let tv = editableTextView(in: host) else { return false }
        window.makeFirstResponder(tv)
        settle()
        for ch in text { key(window, String(ch), code: ch == " " ? 49 : 0) }
        key(window, "\r", code: 36)
        return true
    }

    static func editableTextView(in view: NSView) -> NSTextView? {
        if let t = view as? NSTextView, t.isEditable { return t }
        for v in view.subviews { if let t = editableTextView(in: v) { return t } }
        return nil
    }

    static func questionChecks(_ check: (String, Bool) -> Void) {
        // Clicking options: with two questions, one pick waits for the other; the second sends both answers.
        do {
            let sc = questionScene()
            let w = questionWindow(sc, chat: sc.mine)
            defer { w.orderOut(nil) }
            check("question: the options show", clickWords("One commit per layer", in: w))
            check("question: picking one of two answers sends nothing yet", sc.calls.did("answer").isEmpty)
            clickWords("HEAD only", in: w)
            check(
                "question: picking the second answers both questions",
                sc.calls.did("answer") == [[askedSplit: "One commit per layer", askedDepth: "HEAD only"]])
        }
        // Typing while the question waits answers it (with the option already picked), in Chat 2 of a running card.
        do {
            let sc = questionScene()
            let w = questionWindow(sc, chat: sc.mine)
            defer { w.orderOut(nil) }
            clickWords("Merge the shared-file splits", in: w)
            check("question: the message box takes typing", typeAndSend("every commit ships", in: w))
            check(
                "question: a typed message answers what's left, with the pick kept",
                sc.calls.did("answer") == [[askedSplit: "Merge the shared-file splits", askedDepth: "every commit ships"]])
            check("question: a typed answer never goes to the card's agent", sc.calls.steered.isEmpty)
        }
        do {
            let sc = questionScene()
            let w = questionWindow(sc, chat: sc.mine)
            defer { w.orderOut(nil) }
            _ = typeAndSend("one per layer", in: w)
            check("question: with nothing picked, Chat 2's message goes to its own agent", sc.calls.sent == ["one per layer"])
            check("question: and never to the card's agent", sc.calls.steered.isEmpty)
            // Stop in Chat 2 stops Chat 2's agent, whatever the card does.
            check("question: Stop shows in Chat 2 while its question waits", clickWords("Stop", in: w))
            check("question: Stop stops Chat 2", sc.calls.did("stop").count == 1 && sc.calls.actions.last?.chat == sc.mine.id)
            check("question: Stop in Chat 2 doesn't take the card's wheel", sc.calls.wheel.isEmpty)
            // A message the agent couldn't read says so, with Retry.
            let words = wordsOnScreen(w).map(\.text).joined(separator: " ")
            check("question: an unread message says Not delivered", words.contains("Not delivered"))
            check("question: and no spinner word", !words.contains("Sending"))
            check("question: Retry shows on it", clickWords("Retry", in: w))
            check("question: Retry sends it again", sc.calls.did("retry").count == 1)
        }
        // Answered in his own words, the card shows them as his answer; stopped, it says so.
        do {
            let sc = questionScene()
            guard var q = sc.turn.events.first(where: { $0.kind == "question" }), case .object(var d)? = q.data else {
                return check("question: the scene has a question", false)
            }
            d["answered"] = .bool(true)
            d["typed"] = .string("every commit ships")
            d["answers"] = .object([askedSplit: .string("every commit ships"), askedDepth: .string("HEAD only")])
            q.data = .object(d)
            let turn = Sessions.Turn(
                id: sc.turn.id, chatId: sc.turn.chatId, seq: 1, userText: "yes", status: "working", added: 0, removed: 0, files: 0, events: [q])
            let w = questionWindow(
                QuestionScene(model: sc.model, session: sc.session, mine: sc.mine, cards: sc.cards, turn: turn, calls: sc.calls), chat: sc.mine)
            defer { w.orderOut(nil) }
            let words = wordsOnScreen(w).map(\.text).joined(separator: " ")
            check("question: a typed answer shows as his answer", words.contains("Your answer: every commit ships"))
            check("question: an answered card no longer asks for an answer", !words.contains("write your own answer"))
        }
        // The card's own chat still steers the card's agent, and its Stop still takes the wheel.
        do {
            let sc = questionScene()
            let w = questionWindow(sc, chat: sc.cards)
            defer { w.orderOut(nil) }
            _ = typeAndSend("keep going", in: w)
            check("question: the card's own chat still steers the card", sc.calls.steered == ["atc-1742"])
            clickWords("Stop", in: w)
            check("question: the card's own Stop still takes the wheel", sc.calls.wheel == ["atc-1742"])
        }
    }
}
