import SwiftUI

/// One chat on screen: the session's header (title, status, repo and branch, who started it, its chat tabs), the
/// transcript, and the message box. A card's session says Forge is working it and that anything sent steers it.
struct ChatColumn: View {
    @ObservedObject var model: AppModel
    @ObservedObject var sessions: SessionsModel
    @ObservedObject var terminals = Terminals.shared
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
            // A finished setup shows until the first turn is over; a running or failed one stays.
            if let run = session.setup, run.state != "done" || (session.chats.first?.turns ?? 0) <= 1 { SetupStrip(run: run) }
            if !closable, sessions.changesTab.contains(session.id), sessions.showsChangesTab(session) {
                ChangesTab(sessions: sessions, session: session)
            } else if let chat {
                TranscriptView(sessions: sessions, chat: chat, transcript: sessions.transcript(chat.id))
                    .opensFileLinks(sessions, root: session.folder)
                Composer(sessions: sessions, session: session, chat: chat, compact: compact).padding(.horizontal, compact ? 12 : 24).padding(
                    .bottom, 16)
            } else {
                Spacer()
            }
            if terminals.shown.contains(session.id) {
                TerminalPanel(terminals: terminals, session: session) { model.sessionEnv(session.workspaceId) }
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
                if !session.archived {
                    let open = terminals.shown.contains(session.id)
                    Button(open ? "Hide Terminal" : "Terminal") { terminals.toggle(session, env: model.sessionEnv(session.workspaceId)) }
                        .buttonStyle(ForgeButton(kind: .ghost, hint: compact ? nil : "⌃`", icon: "terminal"))
                        .keyboardShortcut("`", modifiers: .control)
                        .help("A shell in this session's folder, with the workspace's variables")
                }
                if closable {
                    Button {
                        sessions.splitChat = nil
                    } label: {
                        Image(systemName: "xmark").font(.system(size: 11))
                    }
                    .buttonStyle(ForgeButton(kind: .ghost)).help("Close this side")
                }
            }
            HStack(spacing: 6) {
                Text("\(session.repo) ·").fixedSize()
                BranchMenu(sessions: sessions, session: session)
                Text("· \(session.origins)").fixedSize()
            }
            .font(Theme.mono(11)).foregroundStyle(Theme.textMuted)
            .lineLimit(1).padding(.top, 4)
            ChatTabs(sessions: sessions, session: session, current: chat?.id, side: closable)
                .padding(.top, 14)
        }
        .padding(.horizontal, compact ? 16 : 24).padding(.top, 18)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
    }
}

/// The setup script's run at the top of a new session's chat: running (with its time), finished, or failed (plainly,
/// and the agent started anyway). Show opens its output.
struct SetupStrip: View {
    let run: Sessions.ScriptRun
    @State private var open = false

    private var words: String {
        switch run.state {
        case "running": return "Setup script running…"
        case "failed": return "Setup script failed (exit \(run.exitCode.map(String.init) ?? "?")). The agent started anyway."
        default: return "Setup script finished."
        }
    }

    var body: some View {
        let failed = run.state == "failed"
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if run.state == "running" {
                    Spinner()
                } else {
                    Image(systemName: failed ? "xmark.circle.fill" : "checkmark.circle.fill").font(.system(size: 12))
                        .foregroundStyle(failed ? Theme.bad : Theme.good)
                }
                Text(words).font(Theme.sans(12, failed ? .medium : .regular)).foregroundStyle(Theme.text)
                Spacer()
                if !run.output.isBlank {
                    Button(open ? "Hide" : "Show output") { open.toggle() }.buttonStyle(
                        ForgeButton(kind: .ghost, icon: open ? "chevron.up" : "chevron.down"))
                }
            }
            if open || (failed && !run.output.isBlank) {
                ScrollView {
                    // Folded, a failure shows its last lines: that's where the reason is.
                    let tail = run.output.split(separator: "\n", omittingEmptySubsequences: false).suffix(4).joined(separator: "\n")
                    Text(open ? String(run.output.suffix(20000)) : tail).font(Theme.mono(11)).foregroundStyle(Theme.textSec)
                        .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                }
                .frame(maxHeight: open ? 220 : 64)
                .padding(10).background(RoundedRectangle(cornerRadius: Theme.rMd).fill(Theme.bg))
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 10)
        .background(failed ? Theme.badWash : Theme.wash1)
        .overlay(alignment: .bottom) { Rectangle().fill(failed ? Theme.badBorder : Theme.border).frame(height: 1) }
    }
}
