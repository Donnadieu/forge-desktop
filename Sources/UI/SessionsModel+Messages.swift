import Foundation

/// Messages from the box, the agent's questions and messages it couldn't read (Omar's ATC-1742 Chat 2, Nov 12): where a
/// message goes (the card's agent only from the card's own chat), picks on a card with several questions, the
/// question a typed message answers, and Retry.
extension SessionsModel {
    func send(_ chat: Sessions.Chat, text: String, queue: Bool) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let pics = images[chat.id] ?? []
        // Only a card session's own chat steers the card; any other chat in it ("Chat 2") has an agent of its own.
        let target = card(of: chat)
        let pasted = target == nil ? texts[chat.id] ?? [] : []
        guard !t.isEmpty || !pics.isEmpty || !pasted.isEmpty, isHere(chat) else { return }
        drafts[chat.id] = ""
        sent[chat.id, default: 0] += 1
        // The agent waits on its question with some options picked: the typed words answer the questions left.
        // (With none picked, the host takes the message as the answer to every question.)
        if target == nil, !t.isEmpty, let q = waitingQuestion(chat), let picked = questionPicks[q.id], !picked.isEmpty {
            var answers = picked
            for question in QuestionCard.questions(of: q) where answers[question] == nil { answers[question] = t }
            questionPicks[q.id] = nil
            return answer(chat, q, allow: true, answers: answers, typed: t)
        }
        onSend?(chat, t, queue, pasted)
        if let target {
            guard !t.isEmpty else { return }
            Task {
                if let problem = await steerCard?(target.project, target.card, t) {
                    self.problem = problem
                    drafts[chat.id] = t
                }
            }
            return
        }
        images[chat.id] = nil
        texts[chat.id] = nil
        guard let client else { return }
        Task {
            do {
                try await client.send(chat: chat.id, text: t, queue: queue, images: pics.map(\.body), texts: pasted.map(\.body))
            } catch {
                // It never reached the host: the words go back in the box to send again.
                problem = "\(error)"
                if drafts[chat.id]?.isEmpty ?? true { drafts[chat.id] = t }
            }
        }
    }

    /// The question a chat's agent is waiting on, if any.
    func waitingQuestion(_ chat: Sessions.Chat) -> Sessions.Event? {
        guard chat.state == "needs_you" else { return nil }
        return loadedTranscript(chat.id)?.turns.last?.events.last { $0.kind == "question" && $0.data?["answered"]?.bool != true }
    }

    /// An option picked on a card with several questions: it waits for the others, and the last pick sends them all.
    func pick(_ chat: Sessions.Chat, _ e: Sessions.Event, question: String, label: String) {
        var picked = questionPicks[e.id] ?? [:]
        picked[question] = label
        if QuestionCard.questions(of: e).allSatisfy({ picked[$0] != nil }) {
            questionPicks[e.id] = nil
            answer(chat, e, allow: true, answers: picked)
        } else {
            questionPicks[e.id] = picked
        }
    }

    /// Retry on a message the agent couldn't read: the host sends it again.
    func retry(_ chat: Sessions.Chat, _ e: Sessions.Event) {
        guard isHere(chat) else { return }
        onAction?(chat.id, "retry", [:])
        act { try await $0.retry(chat: chat.id, event: e.id) }
    }
}
