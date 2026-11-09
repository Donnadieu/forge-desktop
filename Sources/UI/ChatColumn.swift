import SwiftUI

/// One chat on screen: the session's header (title, status, repo and branch, who started it, its chat tabs), the
/// transcript, and the message box. A card's session says Forge is working it and that anything sent steers it.
struct ChatColumn: View {
    @ObservedObject var model: AppModel
    @ObservedObject var sessions: SessionsModel
    let session: Sessions.Session
    var chatID: String?
    var compact = false
    var closable = false

    private var chat: Sessions.Chat? { sessions.chat(chatID) ?? sessions.activeChat(of: session) }

    var body: some View {
        VStack(spacing: 0) {
            header
            if session.origin == "card", chat?.working == true {
                HStack(spacing: 8) {
                    PulseDot(color: Theme.heat, pulsing: true, size: 6)
                    Text("Forge is working this card. Anything you send steers it. Stop to take the wheel.")
                        .font(Theme.sans(12)).foregroundStyle(Theme.text)
                    Spacer()
                }
                .padding(.horizontal, 20).padding(.vertical, 10)
                .background(Theme.heatWash).overlay(alignment: .bottom) { Rectangle().fill(Theme.heatBorder).frame(height: 1) }
            }
            if let chat {
                TranscriptView(sessions: sessions, chat: chat, transcript: sessions.transcript(chat.id))
                Composer(sessions: sessions, session: session, chat: chat, compact: compact).padding(.horizontal, compact ? 12 : 24).padding(
                    .bottom, 16)
            } else {
                Spacer()
            }
        }
    }

    private var statusPill: Pill {
        switch session.status {
        case "needs_you": return Pill(text: "Needs you", tone: .heat, dot: Theme.heat)
        case "working": return Pill(text: "Working", tone: .heat, dot: Theme.heat, pulsing: true)
        case "review": return Pill(text: "Ready for review", tone: .info)
        case "merged": return Pill(text: "Merged", tone: .green)
        default: return Pill(text: "Idle", tone: .ghost)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Text(session.title).font(Theme.display(compact ? 20 : 26)).foregroundStyle(Theme.text).lineLimit(1)
                statusPill
                Spacer(minLength: 8)
                if closable {
                    Button {
                        sessions.splitChat = nil
                    } label: {
                        Image(systemName: "xmark").font(.system(size: 11))
                    }
                    .buttonStyle(ForgeButton(kind: .ghost)).help("Close this side")
                }
            }
            Text("\(session.repo) · \(session.branch) · \(session.origins)").font(Theme.mono(11)).foregroundStyle(Theme.textMuted)
                .lineLimit(1).padding(.top, 4)
            HStack(spacing: 18) {
                ForEach(session.chats) { c in tab(c) }
                Button {
                    sessions.newChat(in: session, title: session.chats.count == 1 ? "Review" : "Chat \(session.chats.count + 1)")
                } label: {
                    Image(systemName: "plus").font(.system(size: 11)).foregroundStyle(Theme.textMuted)
                }
                .buttonStyle(.plain).help("New chat in this session (⌘T): same folder and branch")
                Spacer()
            }
            .padding(.top, 14)
        }
        .padding(.horizontal, compact ? 16 : 24).padding(.top, 18)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
    }

    private func tab(_ c: Sessions.Chat) -> some View {
        let on = c.id == chat?.id
        return Button {
            if closable { sessions.splitChat = c.id } else { sessions.activeChat[session.id] = c.id }
        } label: {
            HStack(spacing: 6) {
                if c.working { PulseDot(color: Theme.heat, pulsing: true, size: 5) }
                Text(c.title).font(Theme.sans(13, on ? .semibold : .regular)).foregroundStyle(on ? Theme.text : Theme.textMuted)
            }
            .padding(.bottom, 10)
            .overlay(alignment: .bottom) { Rectangle().fill(on ? Theme.text : .clear).frame(height: 2) }
        }
        .buttonStyle(.plain)
        .contextMenu {
            if !closable, session.chats.count > 1 { Button("Open beside this one") { sessions.splitChat = c.id } }
        }
    }
}
