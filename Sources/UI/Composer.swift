import AppKit
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
        .background(Button("") { open.toggle() }.keyboardShortcut("/", modifiers: [.command, .shift]).opacity(0).allowsHitTesting(false))
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
    @State private var focused = false
    /// Bumped by ⌘L to put the cursor in the box.
    @State private var focusRequest = 0
    /// The Skills list (from its button, or the + menu in the narrowest boxes).
    @State private var skillsOpen = false

    /// The card session's own chat steers the card; any other chat in it ("Chat 2") is a chat like any other.
    private var cardsOwn: Bool { SessionsModel.isCardsOwn(chat, in: session) }

    private var placeholder: String {
        if !cardsOwn, sessions.waitingQuestion(chat) != nil { return "Write your own answer…" }
        let who = cardsOwn ? "Steer \(session.title.split(separator: " ").first ?? "")…" : "Message the agent…"
        return who + (chat.working && !cardsOwn ? "  Enter steers · ⌥Enter queues" : "")
    }

    /// The skills list is open while the message starts with "/" and has no space yet.
    private var slashOpen: Binding<Bool> {
        Binding(
            get: { SkillCatalog.slashQuery(sessions.drafts[chat.id] ?? "") != nil },
            set: { open in if !open, SkillCatalog.slashQuery(sessions.drafts[chat.id] ?? "") != nil { sessions.drafts[chat.id] = "" } })
    }

    private var text: Binding<String> {
        Binding(get: { sessions.drafts[chat.id] ?? "" }, set: { sessions.drafts[chat.id] = $0 })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let pics = sessions.images[chat.id], !pics.isEmpty {
                PendingImages(images: pics) { p in sessions.images[chat.id]?.removeAll { $0 == p } }
            }
            if let pasted = sessions.texts[chat.id], !pasted.isEmpty {
                PendingTexts(texts: pasted) { p in sessions.texts[chat.id]?.removeAll { $0.id == p.id } }
            }
            ZStack(alignment: .topLeading) {
                if text.wrappedValue.isEmpty {
                    Text(placeholder).font(Theme.sans(13)).foregroundStyle(Theme.textMuted).padding(.leading, 5).padding(.top, 1).lineLimit(1)
                }
                MessageBox(
                    text: text, focused: $focused, focusRequest: focusRequest,
                    onReturn: { queue in sessions.send(chat, text: text.wrappedValue, queue: queue) }, onPaste: paste
                )
                // "/" at the start opens the skills list, filtered by what follows; a pick runs the skill.
                .popover(isPresented: slashOpen, arrowEdge: .top) {
                    SkillList(skills: sessions.skills(for: session), query: SkillCatalog.slashQuery(text.wrappedValue) ?? "") { skill in
                        sessions.drafts[chat.id] = ""
                        sessions.run(skill, in: chat)
                    }
                }
                .frame(minHeight: 44, maxHeight: MessageBox.maxHeight).fixedSize(horizontal: false, vertical: true)
            }
            // A narrow chat (the narrowest window with Changes open, or two side by side) gets the short words, so the
            // box never pushes past its column.
            ViewThatFits(in: .horizontal) {
                controls(short: compact)
                controls(short: true)
                controls(short: true, skillsButton: false)
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: Theme.rLg).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: Theme.rLg).stroke(focused ? Theme.borderHover : Theme.border))
        .popover(isPresented: $skillsOpen, arrowEdge: .top) {
            SkillList(skills: sessions.skills(for: session), query: nil) { skill in
                skillsOpen = false
                sessions.run(skill, in: chat)
            }
        }
        .background(
            Button("") { focusRequest += 1 }.keyboardShortcut("l", modifiers: .command).opacity(0).allowsHitTesting(false)
        )
        .background(
            Button("") { if focused, !cardsOwn { sessions.set(chat, planMode: !chat.planMode) } }
                .keyboardShortcut(.tab, modifiers: .shift).opacity(0).allowsHitTesting(false)
        )
        .onDrop(of: [.fileURL, .image], isTargeted: nil) { providers in drop(providers) }
    }

    private func wheelWords(short: Bool) -> String {
        let hands = sessions.card(of: chat)?.handsOn == true
        if short { return hands ? "Your wheel" : "Steering" }
        return hands ? "You have the wheel" : "Steering the card's agent"
    }

    private func controls(short: Bool, skillsButton: Bool = true) -> some View {
        HStack(spacing: 8) {
            if !cardsOwn {
                Menu {
                    Button("Pull PR review comments") { sessions.pullReviewComments(session) }.disabled(session.prNumber == nil)
                    Button("Attach a picture…") { pickPictures() }
                    if !skillsButton { Button("Run a skill…") { skillsOpen = true } }
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
            } else {
                Pill(text: wheelWords(short: short), tone: .ghost)
            }
            // The narrowest boxes (two chats side by side) keep Skills in the + menu instead.
            if skillsButton || cardsOwn { SkillsButton(open: $skillsOpen).fixedSize() }
            if chat.planMode { Pill(text: "Plan mode", tone: .info) }
            if (chat.queued ?? 0) > 0 { Pill(text: "\(chat.queued ?? 0) queued", tone: .ghost) }
            Spacer(minLength: 8)
            if !cardsOwn {
                ModelChip(model: chat.model, effort: chat.effort, short: short) { m, e in
                    sessions.set(chat, model: m != chat.model ? m : nil, effort: e != chat.effort ? e : nil)
                }
                .fixedSize()
            }
            ContextMeter(percent: chat.contextPercent, short: short).fixedSize()
            if let card = sessions.card(of: chat) {
                if card.handsOn {
                    Button("Hand back to Forge") { sessions.wheel(chat, take: false) }
                        .buttonStyle(ForgeButton(kind: .secondary, icon: "arrow.uturn.forward", large: true))
                        .help("Forge's agent carries on by itself from where you left it")
                } else if chat.working {
                    Button("Stop") { sessions.wheel(chat, take: true) }
                        .buttonStyle(ForgeButton(kind: .secondary, icon: "stop.fill", large: true))
                        .keyboardShortcut(.delete, modifiers: [.command, .shift])
                        .help("Ends the agent's turn now; it waits for your messages until you hand it back")
                }
            }
            if chat.working, !cardsOwn {
                Button("Stop") { sessions.stop(chat) }
                    .buttonStyle(ForgeButton(kind: .secondary, icon: "stop.fill", large: true))
                    .keyboardShortcut(.delete, modifiers: [.command, .shift])
            }
            Button("Send") { sessions.send(chat, text: text.wrappedValue, queue: false) }
                .buttonStyle(ForgeButton(kind: .primary, icon: "paperplane", large: true))
                .disabled(
                    text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (sessions.images[chat.id] ?? []).isEmpty
                        && (sessions.texts[chat.id] ?? []).isEmpty)
        }
    }

    /// Pasted text longer than this joins the message as a .txt file instead of filling the box (no setting).
    static let longPaste = 4000

    /// Pasting into the box (⌘V, Edit > Paste, right-click Paste, Wispr Flow): a long text or a picture on the
    /// clipboard joins the message (not in a card's own chat); anything else is AppKit's own paste (false).
    private func paste(_ board: NSPasteboard) -> Bool {
        guard !cardsOwn else { return false }
        let string = board.string(forType: .string)
        if let string, string.count > Self.longPaste {
            sessions.attachText(string, to: chat)
            return true
        }
        guard string == nil else { return false }
        let pics = MessageImages.fromPasteboard(board)
        if pics.isEmpty { return false }
        sessions.attach(pics, to: chat)
        return true
    }

    private func pickPictures() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = [.png, .jpeg, .gif, .webP, .heic, .tiff]
        guard panel.runModal() == .OK else { return }
        sessions.attach(MessageImages.fromFiles(panel.urls), to: chat)
    }

    private func drop(_ providers: [NSItemProvider]) -> Bool {
        guard !cardsOwn else { return false }
        for p in providers where p.canLoadObject(ofClass: URL.self) {
            _ = p.loadObject(ofClass: URL.self) { url, _ in
                guard let url else { return }
                let pics = MessageImages.fromFiles([url])
                Task { @MainActor in sessions.attach(pics, to: chat) }
            }
        }
        return true
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
