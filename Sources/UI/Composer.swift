import SwiftUI

/// The model and effort chip ("Opus 5.5 · 1M · High"); a click opens the picker: models, then effort.
struct ModelChip: View {
    let model: String
    let effort: String
    /// Narrow columns show the model only; the effort is in the picker.
    var short = false
    let pick: (String, String) -> Void
    @State private var open = false

    var body: some View {
        Button {
            open.toggle()
        } label: {
            HStack(spacing: 6) {
                Text(short ? Sessions.modelName(model) : "\(Sessions.modelName(model)) · \(Sessions.effortName(effort))").font(Theme.mono(11))
                    .foregroundStyle(Theme.text)
                Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.textMuted)
            }
            .padding(.horizontal, 10).frame(height: 30)
            .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(Theme.bg))
            .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.border))
        }
        .buttonStyle(.plain)
        .keyboardShortcut("/", modifiers: .command)
        .popover(isPresented: $open, arrowEdge: .top) {
            ModelPicker(model: model, effort: effort) { m, e in
                pick(m, e)
            }
        }
    }
}

struct ModelPicker: View {
    let model: String
    let effort: String
    let pick: (String, String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: "Claude Code · this Mac's sign-in").padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 6)
            ForEach(Sessions.models, id: \.id) { m in
                Button {
                    pick(m.id, effort)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).opacity(m.id == model ? 1 : 0)
                        Text(m.name).font(Theme.sans(13))
                        Spacer()
                    }
                    .foregroundStyle(Theme.text)
                    .padding(.horizontal, 12).frame(height: 30)
                    .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(m.id == model ? Theme.surfaceHover : .clear))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 6)
            }
            Rectangle().fill(Theme.border).frame(height: 1).padding(.vertical, 8)
            SectionLabel(text: "Effort").padding(.horizontal, 14)
            HStack(spacing: 0) {
                ForEach(Sessions.efforts, id: \.id) { e in
                    Button {
                        pick(model, e.id)
                    } label: {
                        Text(e.name).font(Theme.sans(11, e.id == effort ? .semibold : .regular))
                            .foregroundStyle(e.id == effort ? Theme.heatBright : Theme.textSec)
                            .padding(.horizontal, 10).frame(height: 28)
                            .background(e.id == effort ? Theme.heatWash : .clear)
                            .overlay(Rectangle().stroke(e.id == effort ? Theme.heatBorder : .clear))
                    }
                    .buttonStyle(.plain)
                }
            }
            .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.border))
            .padding(.horizontal, 14).padding(.top, 8)
            Text("Applies from the next turn").font(Theme.sans(11)).foregroundStyle(Theme.textMuted)
                .padding(.horizontal, 14).padding(.vertical, 12)
        }
        .frame(width: 330)
        .background(Theme.surface)
    }
}

/// The message box at the bottom of a chat: Enter steers the running turn (or starts one), ⌥Enter queues it,
/// Stop ends the turn. The + menu pulls review comments in; the meter shows how full the context is.
struct Composer: View {
    @ObservedObject var sessions: SessionsModel
    let session: Sessions.Session
    let chat: Sessions.Chat
    var compact = false
    @FocusState private var focused: Bool

    private var placeholder: String {
        let who = session.origin == "card" ? "Steer \(session.title.split(separator: " ").first ?? "")…" : "Message the agent…"
        return who + (chat.working ? "  Enter steers · ⌥Enter queues" : "")
    }

    private var text: Binding<String> {
        Binding(get: { sessions.drafts[chat.id] ?? "" }, set: { sessions.drafts[chat.id] = $0 })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack(alignment: .topLeading) {
                if text.wrappedValue.isEmpty {
                    Text(placeholder).font(Theme.sans(13)).foregroundStyle(Theme.textMuted).padding(.leading, 5).padding(.top, 1).lineLimit(1)
                }
                TextEditor(text: text).font(Theme.sans(13)).foregroundStyle(Theme.text).scrollContentBackground(.hidden)
                    .frame(minHeight: 44, maxHeight: 180).fixedSize(horizontal: false, vertical: true)
                    .focused($focused)
                    .onKeyPress(.return, phases: .down) { press in
                        if press.modifiers.contains(.shift) { return .ignored }
                        sessions.send(chat, text: text.wrappedValue, queue: press.modifiers.contains(.option))
                        return .handled
                    }
            }
            HStack(spacing: 8) {
                Menu {
                    Button("Pull PR review comments") { sessions.pullReviewComments(session) }.disabled(session.prNumber == nil)
                    Button(chat.planMode ? "Leave plan mode" : "Plan first (plan mode)") { sessions.set(chat, planMode: !chat.planMode) }
                    Button(chat.askBeforeChanges ? "Stop asking before changes" : "Ask before changes") {
                        sessions.set(chat, ask: !chat.askBeforeChanges)
                    }
                } label: {
                    Image(systemName: "plus").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.textSec)
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .frame(width: 30, height: 30)
                .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.border))
                if chat.planMode { Pill(text: "Plan mode", tone: .info) }
                if (chat.queued ?? 0) > 0 { Pill(text: "\(chat.queued ?? 0) queued", tone: .ghost) }
                Spacer(minLength: 8)
                ModelChip(model: chat.model, effort: chat.effort, short: compact) { m, e in
                    sessions.set(chat, model: m != chat.model ? m : nil, effort: e != chat.effort ? e : nil)
                }
                .fixedSize()
                ContextMeter(percent: chat.contextPercent, short: compact).fixedSize()
                if chat.working {
                    Button("Stop") { sessions.stop(chat) }
                        .buttonStyle(ForgeButton(kind: .secondary, icon: "stop.fill", large: true))
                        .keyboardShortcut(.delete, modifiers: [.command, .shift])
                }
                Button("Send") { sessions.send(chat, text: text.wrappedValue, queue: false) }
                    .buttonStyle(ForgeButton(kind: .primary, icon: "paperplane", large: true))
                    .disabled(text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: Theme.rLg).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: Theme.rLg).stroke(focused ? Theme.borderHover : Theme.border))
        .background(
            Button("") { focused = true }.keyboardShortcut("l", modifiers: .command).opacity(0).allowsHitTesting(false))
    }
}

struct ContextMeter: View {
    let percent: Int
    var short = false

    var body: some View {
        HStack(spacing: 6) {
            Text(short ? "\(percent)%" : "Context \(percent)%").font(Theme.mono(10)).foregroundStyle(Theme.textMuted)
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.wash2).frame(width: 28, height: 4)
                Capsule().fill(percent > 80 ? Theme.heat : Theme.textSec).frame(width: 28 * CGFloat(percent) / 100, height: 4)
            }
        }
        .help("How much of the model's context this chat uses")
    }
}
