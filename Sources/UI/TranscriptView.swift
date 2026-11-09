import SwiftUI

/// A chat's transcript: one row per turn in a native list that reuses its rows, so a chat of thousands of turns stays
/// smooth. Only the newest turns are loaded; older ones arrive when the top comes near. Tool calls are folded to one
/// line; their output opens on a click. It follows the agent while it writes.
struct TranscriptView: View {
    @ObservedObject var sessions: SessionsModel
    let chat: Sessions.Chat
    @ObservedObject var transcript: Transcript
    /// The bottom of the chat is on screen: new text follows it. Scrolled up, it stays put and offers Jump to latest.
    @State private var atEnd = true

    var body: some View {
        ScrollViewReader { proxy in
            List {
                if transcript.hasOlder {
                    HStack {
                        Spacer()
                        Text(transcript.loading ? "Loading earlier turns…" : "Earlier turns").font(Theme.sans(11)).foregroundStyle(Theme.textMuted)
                        Spacer()
                    }
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
                    .onAppear { Task { await transcript.loadOlder(sessions.client) } }
                }
                ForEach(transcript.turns) { t in
                    TurnView(sessions: sessions, chat: chat, turn: t)
                        .listRowInsets(EdgeInsets(top: 8, leading: 24, bottom: 8, trailing: 24))
                        .listRowBackground(Color.clear).listRowSeparator(.hidden)
                        .id(t.id)
                }
                Color.clear.frame(height: 8).id("end").listRowBackground(Color.clear).listRowSeparator(.hidden)
                    .onAppear { atEnd = true }
                    .onDisappear { atEnd = false }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .defaultScrollAnchor(.bottom)
            .onChange(of: transcript.turns.last?.events.last) { _, _ in
                if chat.working, atEnd { proxy.scrollTo("end", anchor: .bottom) }
            }
            // A new turn (not older ones loading at the top) brings the chat to its end.
            .onChange(of: transcript.turns.last?.id) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
            .overlay(alignment: .bottom) {
                if !atEnd, !transcript.turns.isEmpty {
                    Button("Jump to latest") {
                        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("end", anchor: .bottom) }
                    }
                    .buttonStyle(ForgeButton(kind: .secondary, icon: "arrow.down"))
                    .shadow(color: .black.opacity(0.4), radius: 10)
                    .padding(.bottom, 12)
                    .transition(.opacity)
                }
            }
        }
    }
}

/// One turn: your message, then what the agent did and said, then how it ended and what it changed.
struct TurnView: View {
    @ObservedObject var sessions: SessionsModel
    let chat: Sessions.Chat
    let turn: Sessions.Turn
    @State private var hover = false

    private var results: [String: Sessions.Event] {
        Dictionary(turn.events.filter { $0.kind == "tool_result" }.compactMap { e in e.ref.map { ($0, e) } }, uniquingKeysWith: { a, _ in a })
    }

    private var lastTool: String? { turn.events.last { $0.kind == "tool" }?.id }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            let res = results
            ForEach(Array(turn.events.enumerated()), id: \.element.id) { i, e in
                switch e.kind {
                case "user":
                    if e.name == "steered" { SteerBubble(text: e.text) } else { UserBubble(text: e.text) { revertButton } }
                case "text": MessageText(text: e.text, writing: turn.status == "working" && i == turn.events.count - 1)
                case "thinking": FoldRow(icon: "brain", title: "Thought", detail: e.text.isEmpty ? nil : e.text)
                case "tool": ToolRow(event: e, result: res[e.id], running: turn.status == "working" && res[e.id] == nil && e.id == lastTool)
                case "question": QuestionCard(sessions: sessions, chat: chat, event: e)
                case "plan": PlanCard(sessions: sessions, chat: chat, event: e)
                case "permission": PermissionCard(sessions: sessions, chat: chat, event: e)
                case "error": Notice(title: e.text)
                case "note": Text(e.text).font(Theme.sans(12)).foregroundStyle(Theme.textMuted)
                default: EmptyView()
                }
            }
            footer
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onHover { hover = $0 }
    }

    @ViewBuilder private var revertButton: some View {
        if hover, !chat.working, turn.status != "working" {
            Button("Go back to before this") { sessions.revert(chat, turn: turn) }
                .buttonStyle(ForgeButton(kind: .ghost, icon: "arrow.uturn.backward"))
                .help(
                    "Puts every file back as it was before this message and removes it and everything after it from the chat. This can't be undone.")
        }
    }

    @ViewBuilder private var footer: some View {
        let line: String? =
            switch turn.status {
            case "stopped": "You stopped this turn."
            case "interrupted": "Forge closed while the agent worked. Send a message to carry on."
            case "working": nil
            default: nil
            }
        HStack(spacing: 10) {
            if let line { Text(line).font(Theme.sans(11)).foregroundStyle(Theme.textMuted) }
            if turn.files > 0 {
                Text("\(turn.files == 1 ? "1 file" : "\(turn.files) files") +\(turn.added) −\(turn.removed)").font(Theme.mono(10))
                    .foregroundStyle(Theme.textMuted)
            }
            if turn.status == "working", turn.events.last?.kind == "user" { Spinner() }
        }
    }
}

struct UserBubble<Revert: View>: View {
    let text: String
    @ViewBuilder var revert: Revert

    var body: some View {
        HStack(alignment: .top) {
            Spacer(minLength: 80)
            revert
            let parts = MessageImages.split(text)
            VStack(alignment: .trailing, spacing: 8) {
                if !parts.paths.isEmpty { ImageStrip(paths: parts.paths) }
                if !parts.words.isEmpty {
                    Text(parts.words.count > 4000 ? String(parts.words.prefix(4000)) + "…" : parts.words).font(Theme.sans(13))
                        .foregroundStyle(Theme.text)
                        .textSelection(.enabled)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: Theme.rLg).fill(Theme.surface))
            .overlay(RoundedRectangle(cornerRadius: Theme.rLg).stroke(Theme.border))
        }
    }
}

struct SteerBubble: View {
    let text: String

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            SectionLabel(text: "You · steered")
            Text(text).font(Theme.sans(13)).foregroundStyle(Theme.text).textSelection(.enabled)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .overlay(RoundedRectangle(cornerRadius: Theme.rLg).stroke(Theme.borderHover, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/// A folded line ("Thought", a tool call) that opens to show more.
struct FoldRow: View {
    let icon: String
    let title: String
    var detail: String?
    var tail: String?
    var running = false
    var isError = false
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                if detail != nil { open.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: open ? "chevron.down" : "chevron.right").font(.system(size: 8, weight: .bold))
                        .foregroundStyle(Theme.textMuted).opacity(detail == nil ? 0.3 : 1)
                    Text(title).font(Theme.mono(11)).foregroundStyle(isError ? Theme.heat : Theme.textSec).lineLimit(1)
                    if running { Spinner() }
                    if let tail { Text(tail).font(Theme.mono(10)).foregroundStyle(Theme.textMuted) }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open, let detail {
                Text(detail).font(Theme.mono(11)).foregroundStyle(Theme.textSec).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10).background(RoundedRectangle(cornerRadius: Theme.rMd).fill(Theme.bg))
                    .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.border))
            }
        }
    }
}

struct ToolRow: View {
    let event: Sessions.Event
    let result: Sessions.Event?
    let running: Bool

    private var detail: String? {
        var parts: [String] = []
        if case .object(let input)? = event.data {
            if let cmd = input["command"]?.string { parts.append("$ " + cmd) }
            if let new = input["new_string"]?.string { parts.append(new) }
            if let content = input["content"]?.string { parts.append(String(content.prefix(2000))) }
        }
        if let r = result, !r.text.isEmpty {
            parts.append(r.size > r.text.count ? r.text + "\n… \(r.size - r.text.count) more characters" : r.text)
        }
        return parts.isEmpty ? nil : parts.joined(separator: "\n\n")
    }

    var body: some View {
        FoldRow(icon: "wrench", title: event.text, detail: detail, running: running, isError: result?.isError == true)
    }
}
