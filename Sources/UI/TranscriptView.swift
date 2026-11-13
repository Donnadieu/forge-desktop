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
                        Text(transcript.loading ? "Loading earlier turns…" : "Earlier turns").font(Theme.sans(.chatCaption)).foregroundStyle(
                            Theme.textMuted)
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
                // Messages waiting for the turn to end show at once, in order, under the turn they follow.
                ForEach(Array((chat.queue ?? []).enumerated()), id: \.offset) { _, text in
                    SteerBubble(text: text, label: "You · queued")
                        .listRowInsets(EdgeInsets(top: 4, leading: 24, bottom: 4, trailing: 24))
                        .listRowBackground(Color.clear).listRowSeparator(.hidden)
                }
                Color.clear.frame(height: 8).id("end").listRowBackground(Color.clear).listRowSeparator(.hidden)
                    .onAppear { atEnd = true }
                    .onDisappear { atEnd = false }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .modifier(OpensAtBottom())
            // New text or a new turn is followed only while the bottom is on screen: scrolled up, the chat stays put
            // and Jump to latest shows. The person's own message always brings it down.
            .onChange(of: transcript.turns.last?.events.last) { _, _ in
                if atEnd { follow(proxy) }
            }
            .onChange(of: transcript.turns.last?.id) { _, _ in
                if atEnd { follow(proxy) }
            }
            .onChange(of: sessions.sent[chat.id]) { _, _ in follow(proxy) }
            .onAppear { follow(proxy) }
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

extension TranscriptView {
    /// To the end, then again once the new rows are measured (a list measures rows as they come on screen, so the
    /// first scroll can stop short of the end and lose the follow).
    func follow(_ proxy: ScrollViewProxy) {
        proxy.scrollTo("end", anchor: .bottom)
        DispatchQueue.main.async { proxy.scrollTo("end", anchor: .bottom) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { proxy.scrollTo("end", anchor: .bottom) }
    }
}

/// Opens at the bottom without holding it there: on macOS 15 and later the anchor is for the first position only, so
/// content growing above a reader who scrolled up doesn't move them.
private struct OpensAtBottom: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 15, *) {
            content.defaultScrollAnchor(.bottom, for: .initialOffset)
        } else {
            content.defaultScrollAnchor(.bottom)
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
                    if e.name == "steered" {
                        SteerBubble(text: e.text, delivery: e.delivery, retry: e.delivery == "failed" ? { sessions.retry(chat, e) } : nil)
                    } else {
                        UserBubble(text: e.text, unfold: sessions.session(of: chat)?.origin == "card" ? "Show full prompt" : "Show full message") {
                            revertButton
                        }
                    }
                case "text": MessageText(text: e.text, writing: turn.status == "working" && i == turn.events.count - 1)
                case "thinking":
                    // Its first words show on the row; a click opens the rest. Thoughts recorded before Forge asked
                    // Claude Code for their words have none to show.
                    FoldRow(icon: "brain", title: "Thought", detail: e.text.isEmpty ? nil : e.text, tail: Self.firstLine(e.text))
                        .help(e.text.isEmpty ? "Claude Code didn't keep the words of this thought" : "")
                case "tool": ToolRow(event: e, result: res[e.id], running: turn.status == "working" && res[e.id] == nil && e.id == lastTool)
                case "question": QuestionCard(sessions: sessions, chat: chat, event: e)
                case "plan": PlanCard(sessions: sessions, chat: chat, event: e)
                case "permission": PermissionCard(sessions: sessions, chat: chat, event: e)
                case "error": Notice(title: e.text)
                case "note": Text(e.text).font(Theme.sans(.chatNote)).foregroundStyle(Theme.textMuted)
                default: EmptyView()
                }
            }
            footer
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onHover { hover = $0 }
    }

    static func firstLine(_ text: String) -> String? {
        let line = text.split(whereSeparator: \.isNewline).first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        return line.isEmpty ? nil : line
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
            if let line { Text(line).font(Theme.sans(.chatCaption)).foregroundStyle(Theme.textMuted) }
            if turn.files > 0 {
                Text("\(turn.files == 1 ? "1 file" : "\(turn.files) files") +\(turn.added) −\(turn.removed)").font(Theme.mono(.toolMeta))
                    .foregroundStyle(Theme.textMuted)
            }
            if turn.status == "working", turn.events.last?.kind == "user" { Spinner() }
        }
    }
}

struct UserBubble<Revert: View>: View {
    let text: String
    /// What the unfold button says on a long message ("Show full prompt" for a card's prompt).
    var unfold = "Show full message"
    @ViewBuilder var revert: Revert
    @State private var open = false

    /// Long messages (a card's whole prompt) open folded to their first lines.
    static func isLong(_ words: String) -> Bool {
        words.count > 600 || words.split(separator: "\n", omittingEmptySubsequences: false).count > 12
    }

    var body: some View {
        HStack(alignment: .top) {
            Spacer(minLength: 80)
            revert
            let parts = MessageImages.split(text)
            let long = Self.isLong(parts.words)
            VStack(alignment: .leading, spacing: 8) {
                if !parts.paths.isEmpty { ImageStrip(paths: parts.paths) }
                if !parts.texts.isEmpty { SentTexts(paths: parts.texts) { NSWorkspace.shared.open(URL(fileURLWithPath: $0)) } }
                if !parts.words.isEmpty {
                    // Folded, only the start is drawn: a prompt of thousands of lines stays cheap in the list.
                    let shown = long && !open ? String(parts.words.prefix(1200)) : String(parts.words.prefix(40_000))
                    MessageText(text: shown, fill: false)
                        .frame(maxHeight: long && !open ? 150 : nil, alignment: .top)
                        .clipped()
                        .mask(LinearGradient(stops: long && !open ? Self.fade : Self.solid, startPoint: .top, endPoint: .bottom))
                    if long {
                        Button(open ? "Show less" : unfold) { open.toggle() }
                            .buttonStyle(ForgeButton(kind: .ghost, icon: open ? "chevron.up" : "chevron.down"))
                    }
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: Theme.rLg).fill(Theme.surface))
            .overlay(RoundedRectangle(cornerRadius: Theme.rLg).stroke(Theme.border))
        }
    }

    private static var fade: [Gradient.Stop] {
        [.init(color: .black, location: 0), .init(color: .black, location: 0.7), .init(color: .clear, location: 1)]
    }
    private static var solid: [Gradient.Stop] { [.init(color: .black, location: 0), .init(color: .black, location: 1)] }
}

struct SteerBubble: View {
    let text: String
    /// "sending" until the agent has read it, then "delivered"; "failed" when the agent couldn't read it in time (nil:
    /// an older steer, no state shown).
    var delivery: String? = nil
    var label = "You · steered"
    /// Sends a message that said Not delivered again.
    var retry: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            HStack(spacing: 6) {
                SectionLabel(text: label)
                if delivery == "failed" {
                    Text("Not delivered").font(Theme.sans(.chatCaption, .medium)).foregroundStyle(Theme.heat)
                    if let retry { Button("Retry", action: retry).buttonStyle(ForgeButton(kind: .secondary)) }
                } else if let delivery {
                    Text(delivery == "delivered" ? "Delivered" : "Sending…").font(Theme.sans(.chatCaption)).foregroundStyle(Theme.textMuted)
                }
            }
            Text(text).font(Theme.sans(.chatBody)).foregroundStyle(Theme.text).textSelection(.enabled)
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
                    Image(systemName: open ? "chevron.down" : "chevron.right").font(Theme.icon(.glyphTiny, .bold))
                        .foregroundStyle(Theme.textMuted).opacity(detail == nil ? 0.3 : 1)
                    Image(systemName: icon).font(Theme.icon(.glyphS)).foregroundStyle(Theme.textMuted).frame(width: 14)
                    Text(title).font(Theme.mono(.toolTitle)).foregroundStyle(isError ? Theme.heat : Theme.textSec).lineLimit(1)
                    if running { Spinner() }
                    if let tail { Text(tail).font(Theme.sans(.chatNote)).foregroundStyle(Theme.textMuted).lineLimit(1).truncationMode(.tail) }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open, let detail {
                Text(detail).font(Theme.mono(.toolTitle)).foregroundStyle(Theme.textSec).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10).background(RoundedRectangle(cornerRadius: Theme.rMd).fill(Theme.bg))
                    .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.border))
            }
        }
    }
}
