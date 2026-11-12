import SwiftUI

/// The agent asked a multiple-choice question: each option is a button; the answer goes back to it. With several
/// questions, each pick waits until every question has one. A message typed in the box answers it too.
struct QuestionCard: View {
    @ObservedObject var sessions: SessionsModel
    let chat: Sessions.Chat
    let event: Sessions.Event

    private var questions: [JSONValue] { event.data?["input"]?["questions"]?.array ?? [] }
    private var answered: Bool { event.data?["answered"]?.bool == true }
    private var stopped: Bool { event.data?["stopped"]?.bool == true }

    /// The words of each question an AskUserQuestion event asks, in order.
    static func questions(of e: Sessions.Event) -> [String] {
        (e.data?["input"]?["questions"]?.array ?? []).compactMap { $0["question"]?.string }
    }

    private func chosen(_ question: String) -> String? {
        answered ? event.data?["answers"]?[question]?.string : sessions.questionPicks[event.id]?[question]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(questions.enumerated()), id: \.offset) { _, q in
                let question = q["question"]?.string ?? ""
                let options = q["options"]?.array ?? []
                Text(question).font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(options.enumerated()), id: \.offset) { _, o in
                        let label = o["label"]?.string ?? ""
                        let chosen = chosen(question) == label
                        Button {
                            if questions.count > 1 {
                                sessions.pick(chat, event, question: question, label: label)
                            } else {
                                sessions.answer(chat, event, allow: true, answers: [question: label])
                            }
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(label).font(Theme.sans(13, .medium))
                                if let d = o["description"]?.string { Text(d).font(Theme.sans(11)).foregroundStyle(Theme.textMuted) }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(chosen ? Theme.heatWash : Theme.bg))
                            .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(chosen ? Theme.heatBorder : Theme.border))
                        }
                        .buttonStyle(.plain)
                        .disabled(answered)
                    }
                    // His own words, typed in the box, show as his answer.
                    if answered, let own = chosen(question), !options.contains(where: { $0["label"]?.string == own }) {
                        Text("Your answer: \(own)").font(Theme.sans(12)).foregroundStyle(Theme.text).textSelection(.enabled)
                    }
                }
            }
            if stopped {
                Text("Stopped before it was answered.").font(Theme.sans(11)).foregroundStyle(Theme.textMuted)
            } else if !answered {
                Text(
                    questions.count > 1
                        ? "Pick one for each question, or write your own answer below and send it." : "Or write your own answer below and send it."
                )
                .font(Theme.sans(11)).foregroundStyle(Theme.textMuted)
            }
        }
        .padding(14)
        .panel(live: !answered)
    }
}

/// The agent's plan: read it, then Approve (it starts working) or Keep planning with a note.
struct PlanCard: View {
    @ObservedObject var sessions: SessionsModel
    let chat: Sessions.Chat
    let event: Sessions.Event
    @State private var note = ""

    private var answered: Bool { event.data?["answered"]?.bool == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: "Plan")
            if !event.text.isEmpty {
                MessageText(text: event.text)
            } else {
                Text("The plan is in the agent's message above.").font(Theme.sans(12)).foregroundStyle(Theme.textMuted)
            }
            if answered {
                Text(event.data?["allow"]?.bool == true ? "Approved." : "Sent back to keep planning.").font(Theme.sans(12)).foregroundStyle(
                    Theme.textMuted)
            } else {
                TextField("", text: $note).forgeField(hint: "What to change (for Keep planning)", empty: note.isEmpty)
                HStack {
                    Button("Approve and build") { sessions.answer(chat, event, allow: true) }
                        .buttonStyle(ForgeButton(kind: .primary, hint: "⌘⇧↵", large: true))
                        .keyboardShortcut(.return, modifiers: [.command, .shift])
                    Button("Keep planning") { sessions.answer(chat, event, allow: false, feedback: note.isEmpty ? "Keep planning." : note) }
                        .buttonStyle(ForgeButton(kind: .secondary, large: true))
                }
            }
        }
        .padding(14)
        .panel(live: !answered)
    }
}

/// "Ask before changes" is on: the agent wants to do something; Allow or Don't.
struct PermissionCard: View {
    @ObservedObject var sessions: SessionsModel
    let chat: Sessions.Chat
    let event: Sessions.Event

    private var answered: Bool { event.data?["answered"]?.bool == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("The agent wants to: \(event.text)").font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
            if let reason = event.data?["reason"]?.string, !reason.isEmpty {
                Text(reason).font(Theme.sans(11)).foregroundStyle(Theme.textMuted)
            }
            if answered {
                Text(event.data?["allow"]?.bool == true ? "Allowed." : "Not allowed.").font(Theme.sans(12)).foregroundStyle(Theme.textMuted)
            } else {
                HStack {
                    Button("Allow") { sessions.answer(chat, event, allow: true) }.buttonStyle(ForgeButton(kind: .primary, large: true))
                    Button("Don't") { sessions.answer(chat, event, allow: false) }.buttonStyle(ForgeButton(kind: .secondary, large: true))
                }
            }
        }
        .padding(14)
        .panel(live: !answered)
    }
}
