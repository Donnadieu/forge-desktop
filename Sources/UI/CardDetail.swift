import SwiftUI

/// A card's detail: what its agent is doing, its helpers, recent activity, the branch and pull request
/// on the left; the workpad (the agent's one running note on the card) on the right.
struct CardDetail: View {
    @ObservedObject var model: AppModel
    let card: EngineState.Card
    let close: () -> Void
    @State private var workpad: String?
    @State private var loaded = false
    @State private var steerText = ""
    @State private var sending = false
    @State private var wheelBusy = false
    @State private var steerProblem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Rectangle().fill(Theme.border).frame(height: 1)
            HStack(alignment: .top, spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        agentSection
                        codeSection
                    }
                    .padding(24)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxWidth: .infinity)
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        SectionLabel(text: "Workpad")
                        Text("The agent's one running note on this card.").font(Theme.sans(.small)).foregroundStyle(Theme.textMuted)
                            .padding(.bottom, 10)
                        if let workpad, !workpad.isEmpty {
                            WorkpadView(text: workpad)
                        } else {
                            Text(loaded ? "No workpad on this card yet." : "Reading…").font(Theme.sans(.body)).foregroundStyle(Theme.textSec)
                        }
                    }
                    .padding(24)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(width: 360)
                .background(Theme.wash1)
                .overlay(alignment: .leading) { Rectangle().fill(Theme.border).frame(width: 1) }
            }
        }
        .frame(width: 880, height: 640)
        .background(Theme.surface)
        .foregroundStyle(Theme.text)
        .tint(Theme.heat)
        .preferredColorScheme(.dark)
        .task {
            workpad = model.preview ? model.sample.workpad : await model.link.workpad(card: card.id)?.workpad
            loaded = true
        }
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Text(card.identifier).font(Theme.mono(.caption)).foregroundStyle(Theme.textMuted)
                    Pill(text: card.state, stage: card.state, dot: card.agent != nil ? Theme.stage(card.state).dot : nil, pulsing: card.agent != nil)
                }
                Text(card.title).font(Theme.display(.sheetTitle)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 24)
            if card.agent != nil {
                Button("Open session", action: openSession)
                    .buttonStyle(ForgeButton(kind: .secondary, icon: "bubble.left.and.text.bubble.right"))
                    .help("Read the agent's whole conversation and steer it")
            }
            Button("Done", action: close)
                .buttonStyle(ForgeButton(kind: .ghost, hint: "esc"))
                .keyboardShortcut(.cancelAction)
        }
        .padding(24)
    }

    private func openSession() {
        model.openCardSession(project: model.viewedProject, card: card)
        close()
    }

    @ViewBuilder private var agentSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: "Agent now")
            if let agent = card.agent {
                HStack(alignment: .top, spacing: 12) {
                    Spinner(heat: true).padding(.top, 4)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(card.activity ?? "Working").font(Theme.sans(.subtitle)).foregroundStyle(Theme.text)
                        Text("Turn \(agent.turn) · attempt \(agent.attempt)").font(Theme.mono(.caption)).foregroundStyle(Theme.textMuted)
                    }
                }
            } else {
                Text("No agent has this card right now.").font(Theme.sans(.body)).foregroundStyle(Theme.textSec)
            }
        }
        if !card.helpers.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: "Helpers")
                VStack(spacing: 0) {
                    ForEach(Array(card.helpers.enumerated()), id: \.element.id) { i, h in
                        if i > 0 { Rectangle().fill(Theme.border).frame(height: 1) }
                        HStack(spacing: 10) {
                            if h.running {
                                Spinner(heat: true)
                            } else {
                                Image(systemName: "checkmark.circle.fill").font(Theme.icon(.glyphM)).foregroundStyle(Theme.good)
                            }
                            Text(h.description).font(Theme.sans(.body)).foregroundStyle(h.running ? Theme.text : Theme.textSec)
                            Spacer()
                            Chip(text: h.running ? "Running" : "Done", tone: h.running ? .heat : .quiet)
                        }
                        .padding(.horizontal, 12)
                        .frame(minHeight: 40)
                    }
                }
                .panel(Theme.wash1)
            }
        }
        if let recent = card.recent, !recent.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: "Recent activity")
                ForEach(Array(recent.suffix(12).reversed().enumerated()), id: \.offset) { i, l in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(Self.time(l.at)).foregroundStyle(Theme.textMuted)
                        Text(l.line).foregroundStyle(i == 0 ? Theme.text : Theme.textSec)
                    }
                    .font(Theme.mono(.small))
                }
            }
        }
        if card.agent != nil { steerSection }
    }

    /// A message box right under Recent activity: steers the agent mid-task without leaving the card, plus
    /// Stop (take the wheel) and Hand back to Forge once taken over (AppModel+CardSessions.swift).
    @ViewBuilder private var steerSection: some View {
        let handsOn = card.agent?.hands_on ?? false
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: "Steer")
            if let steerProblem {
                Text(steerProblem).font(Theme.sans(.small)).foregroundStyle(Theme.heat)
            }
            HStack(spacing: 8) {
                TextField(handsOn ? "Send the next message…" : "Steer the agent right now…", text: $steerText, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(Theme.sans(.body))
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: Theme.rSm).fill(Theme.wash1))
                    .overlay(RoundedRectangle(cornerRadius: Theme.rSm).stroke(Theme.border))
                    .onSubmit(send)
                Button("Send", action: send)
                    .buttonStyle(ForgeButton(kind: .secondary, icon: "arrow.up.circle.fill"))
                    .disabled(steerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
            }
            HStack(spacing: 8) {
                if handsOn {
                    Button("Hand back to Forge") { toggleWheel(take: false) }
                        .buttonStyle(ForgeButton(kind: .secondary, icon: "arrow.uturn.forward"))
                        .help("Forge's agent carries on by itself from where you left it")
                } else {
                    Button("Stop") { toggleWheel(take: true) }
                        .buttonStyle(ForgeButton(kind: .secondary, icon: "stop.fill"))
                        .help("Ends the agent's turn now; it waits for your messages until you hand it back")
                }
                if wheelBusy { Spinner(heat: true) }
            }
        }
    }

    private func send() {
        let text = steerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let project = model.viewedProject else { return }
        steerText = ""
        sending = true
        Task {
            let problem = await model.sessions.steerCard?(project, card.id, text)
            sending = false
            steerProblem = problem
        }
    }

    private func toggleWheel(take: Bool) {
        guard let project = model.viewedProject else { return }
        wheelBusy = true
        Task {
            let problem = await model.sessions.cardWheel?(project, card.id, take)
            wheelBusy = false
            steerProblem = problem
        }
    }

    private var codeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: "Code")
            if let b = card.branchName {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.triangle.branch").font(Theme.icon(.glyph)).foregroundStyle(Theme.textMuted)
                    Text("Branch").font(Theme.sans(.body)).foregroundStyle(Theme.textSec)
                    Text(b).font(Theme.mono(.small)).foregroundStyle(Theme.text).textSelection(.enabled)
                        .padding(.horizontal, 8).frame(height: 22)
                        .background(RoundedRectangle(cornerRadius: 4).fill(Color.black.opacity(0.25)))
                }
            }
            HStack(spacing: 8) {
                if let pr = card.prUrl {
                    let number = pr.split(separator: "/").last.map { " #\($0)" } ?? ""
                    Button("Open pull request\(number)") { model.openLink(pr) }
                        .buttonStyle(ForgeButton(kind: .secondary, icon: "arrow.triangle.pull"))
                }
                if let u = card.url {
                    Button("Open in \(model.choices.board.site)") { model.openLink(u) }
                        .buttonStyle(ForgeButton(kind: .secondary, icon: "arrow.up.right.square"))
                }
            }
        }
    }

    static func time(_ iso: String) -> String {
        guard let d = ISO8601DateFormatter.withFraction.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return "" }
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: d)
    }
}

/// The workpad's Markdown, drawn the simple way agents write it: headings, checkboxes, bullets, lines.
struct WorkpadView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, raw in
                line(raw.trimmingCharacters(in: .whitespaces))
            }
        }
        .textSelection(.enabled)
    }

    @ViewBuilder private func line(_ l: String) -> some View {
        if l.hasPrefix("### ") {
            Text(String(l.dropFirst(4))).font(Theme.sans(.body, .semibold)).foregroundStyle(Theme.textSec).padding(.top, 6)
        } else if l.hasPrefix("## ") || l.hasPrefix("# ") {
            Text(String(l.drop { $0 == "#" }.dropFirst())).font(Theme.sans(.title, .semibold)).foregroundStyle(Theme.text)
        } else if l.hasPrefix("- [x] ") || l.hasPrefix("- [X] ") || l.hasPrefix("- [ ] ") {
            let done = !l.hasPrefix("- [ ] ")
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: done ? "checkmark.square.fill" : "square").font(Theme.icon(.glyphM))
                    .foregroundStyle(done ? Theme.textSec : Theme.textMuted)
                Text(inline(String(l.dropFirst(6)))).font(Theme.sans(.body)).foregroundStyle(done ? Theme.textSec : Theme.text)
            }
        } else if l.hasPrefix("- ") || l.hasPrefix("* ") {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("•").foregroundStyle(Theme.textMuted)
                Text(inline(String(l.dropFirst(2)))).font(Theme.sans(.body)).foregroundStyle(Theme.text)
            }
        } else if !l.isEmpty {
            Text(inline(l)).font(Theme.sans(.body)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func inline(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }
}

extension ISO8601DateFormatter {
    nonisolated(unsafe) static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
