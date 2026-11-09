import Foundation

/// Card sessions: every card an agent works right now shows up on the Sessions screen as a session the person can open
/// and steer (docs/design/sessions.md, frame a3). The board engines say which cards run and where their agent's
/// transcript is; the sessions host follows it; a message goes back to the card's own engine.
extension AppModel {
    /// The session id the host gives a card (engine sessions/cards.ts `CardWatcher.sessionId`).
    static func cardSessionID(project: String, card: String) -> String {
        let key = "\(project):\(card)"
        return "card-" + String(key.map { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") ? $0 : "-" })
    }

    /// Every running card with an agent session, from every project's engine.
    var runningCardSessions: [[String: String]] { runningCards.map(\.body) }

    private var runningCards: [(target: CardTarget, body: [String: String])] {
        var out: [(target: CardTarget, body: [String: String])] = []
        for (pid, state) in states.sorted(by: { $0.key < $1.key }) {
            let project = store.project(pid)
            for c in state.cards {
                guard let a = c.agent, let session = a.session_id, let folder = a.folder else { continue }
                out.append(
                    (
                        CardTarget(project: pid, card: c.id, handsOn: a.hands_on ?? false),
                        [
                            "key": "\(pid):\(c.id)", "workspaceId": project?.workspaceID ?? "default", "identifier": c.identifier,
                            "title": c.title, "folder": folder, "sessionId": session, "branch": c.branchName ?? "", "repo": project?.repo ?? "",
                            "model": project?.model ?? "opus",
                        ]
                    ))
            }
        }
        return out
    }

    /// Called whenever an engine's state arrives: the host follows the cards running now.
    func watchCardSessions() {
        let cards = runningCards
        var targets: [String: CardTarget] = [:]
        for c in cards { targets[Self.cardSessionID(project: c.target.project, card: c.target.card)] = c.target }
        if targets != sessions.cardTargets { sessions.cardTargets = targets }
        sessions.watch(cards.map(\.body))
    }

    /// "Open session" on a running card: the Sessions screen with that card's session open.
    func openCardSession(project: String?, card: EngineState.Card) {
        guard let project else { return }
        let id = Self.cardSessionID(project: project, card: card.id)
        go(Self.sessionsScreen)
        sessions.composing = false
        sessions.selected = id
        if let s = sessions.sessions.first(where: { $0.id == id }) { sessions.open(s) }
    }

    /// Wires the card sessions' messages to the card's engine.
    func connectCardSessions() {
        LimitNotifier.shared.openSession = { [weak self] id in
            guard let self else { return }
            go(Self.sessionsScreen)
            sessions.composing = false
            if let s = sessions.sessions.first(where: { $0.id == id }) { sessions.open(s) }
        }
        sessions.steerCard = { [weak self] project, card, text in
            guard let link = self?.links[project] else { return "This project's engine isn't running." }
            return await link.message(card: card, text: text)
        }
        sessions.cardWheel = { [weak self] project, card, take in
            guard let link = self?.links[project] else { return "This project's engine isn't running." }
            return await link.wheel(card: card, take: take)
        }
    }
}
