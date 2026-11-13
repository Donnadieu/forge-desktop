import SwiftUI

/// One chat on screen: the session's header (title, status, repo and branch, who started it, its chat tabs), the
/// transcript, and the message box. A card's session says Forge is working it and that anything sent steers it.
struct ChatColumn: View {
    @ObservedObject var model: AppModel
    @ObservedObject var sessions: SessionsModel
    @ObservedObject var terminals = Terminals.shared
    @ObservedObject var openIn = OpenInModel.shared
    let session: Sessions.Session
    var chatID: String?
    var compact = false
    var closable = false

    private var chat: Sessions.Chat? { sessions.chat(chatID) ?? sessions.activeChat(of: session) }

    var body: some View {
        VStack(spacing: 0) {
            header
            if let problem = openIn.problem[session.id] {
                Notice(title: problem) {
                    Button("Choose another app") {
                        openIn.problem[session.id] = nil
                        openIn.refresh()
                        openIn.menuFor = closable ? "\(session.id):side" : session.id
                    }
                    .buttonStyle(ForgeButton(kind: .fix))
                }
                .padding(.horizontal, compact ? 12 : 24).padding(.top, 12)
            }
            let handsOn = chat.flatMap(sessions.card(of:))?.handsOn == true
            // Only the card's own chat steers the card; another chat in its session ("Chat 2") has its own agent.
            if let chat, SessionsModel.isCardsOwn(chat, in: session), chat.working || handsOn {
                HStack(spacing: 8) {
                    PulseDot(color: Theme.heat, pulsing: !handsOn, size: 6)
                    Text(
                        handsOn
                            ? "You have the wheel. The agent waits for your messages; Hand back to Forge lets it carry on."
                            : "Forge is working this card. Anything you send steers its agent right away. Stop to take over."
                    )
                    .font(Theme.sans(.small)).foregroundStyle(Theme.text)
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
                if session.archived {
                    // Read-only: no message box until it's unarchived.
                    Text("Archived. Its chat is here to read; Unarchive to keep working in it.")
                        .font(Theme.sans(.small)).foregroundStyle(Theme.textSec)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, compact ? 12 : 24).padding(.vertical, 16)
                        .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
                } else {
                    Composer(sessions: sessions, session: session, chat: chat, compact: compact).padding(.horizontal, compact ? 12 : 24).padding(
                        .bottom, 16)
                }
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
        case "archived": return Pill(text: "Archived", tone: .ghost)
        default: return Pill(text: "Idle", tone: .ghost)
        }
    }

    private var header: some View {
        PaneHeader(alignment: .bottomLeading) { headerContent }
    }

    /// Title, status, repo · branch · who started it, then the tabs, which sit on the header's line.
    private var headerContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Text(session.title).font(Theme.display(compact ? .sessionTitleCompact : .sessionTitle)).foregroundStyle(Theme.text).lineLimit(1)
                statusPill
                Spacer(minLength: 8)
                if session.archived {
                    Button("Unarchive") { sessions.restore(session) }
                        .buttonStyle(ForgeButton(kind: .secondary, icon: "arrow.uturn.backward"))
                        .help("Bring it back to its group, with its folder on its branch")
                } else {
                    OpenInButton(openIn: openIn, session: session, checkouts: model.mainCheckouts(of: session), compact: compact, side: closable)
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
                        Image(systemName: "xmark").font(Theme.icon(.glyph))
                    }
                    .buttonStyle(ForgeButton(kind: .ghost)).help("Close this side")
                }
            }
            HStack(spacing: 6) {
                Text("\(session.repo) ·").fixedSize()
                BranchMenu(sessions: sessions, session: session)
                Text("· \(session.origins)").fixedSize()
            }
            .font(Theme.mono(.caption)).foregroundStyle(Theme.textMuted)
            .lineLimit(1).padding(.top, 4)
            ChatTabs(sessions: sessions, session: session, current: chat?.id, side: closable)
                .padding(.top, 14)
        }
        .padding(.horizontal, compact ? 16 : 24)
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
                    Image(systemName: failed ? "xmark.circle.fill" : "checkmark.circle.fill").font(Theme.icon(.glyphM))
                        .foregroundStyle(failed ? Theme.bad : Theme.good)
                }
                Text(words).font(Theme.sans(.small, failed ? .medium : .regular)).foregroundStyle(Theme.text)
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
                    Text(open ? String(run.output.suffix(20000)) : tail).font(Theme.mono(.caption)).foregroundStyle(Theme.textSec)
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
