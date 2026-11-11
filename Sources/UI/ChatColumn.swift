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
            let handsOn = sessions.cardTargets[session.id]?.handsOn == true
            if session.origin == "card", chat?.working == true || handsOn {
                HStack(spacing: 8) {
                    PulseDot(color: Theme.heat, pulsing: !handsOn, size: 6)
                    Text(
                        handsOn
                            ? "You have the wheel. The agent waits for your messages; Hand back to Forge lets it carry on."
                            : "Forge is working this card. Anything you send steers its agent right away. Stop to take over."
                    )
                    .font(Theme.sans(12)).foregroundStyle(Theme.text)
                    Spacer()
                }
                .padding(.horizontal, 20).padding(.vertical, 10)
                .background(Theme.heatWash).overlay(alignment: .bottom) { Rectangle().fill(Theme.heatBorder).frame(height: 1) }
            }
            if !closable, sessions.changesTab.contains(session.id), sessions.showsChangesTab(session) {
                ChangesTab(sessions: sessions, session: session)
            } else if let chat {
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
            ChatTabs(sessions: sessions, session: session, current: chat?.id, side: closable)
                .padding(.top, 14)
        }
        .padding(.horizontal, compact ? 16 : 24).padding(.top, 18)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
    }
}
