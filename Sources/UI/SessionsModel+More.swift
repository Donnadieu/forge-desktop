import AppKit
import Foundation

/// The Sessions screen's smaller actions: telling the person when a chat needs them or is done, the next chat waiting
/// on them, closing a chat, History (archived sessions) and restoring one, and opening a session's folder in an editor.
extension SessionsModel {
    /// A chat that stopped working: a macOS notification with a sound when the person isn't looking at it.
    func notifyIfNeeded(_ next: Sessions.Chat) {
        guard !preview, let old = chat(next.id), old.working, old.state != next.state,
            let s = sessions.first(where: { $0.id == next.sessionId })
        else { return }
        let looking = NSApp.isActive && selected == s.id
        guard !looking else { return }
        switch next.state {
        case "needs_you": LimitNotifier.shared.post("\(s.title) needs you", "The agent is waiting for your answer.", session: s.id)
        case "idle": LimitNotifier.shared.post("\(s.title) is done", "The agent finished its turn.", session: s.id)
        case "failed": LimitNotifier.shared.post("\(s.title) stopped", "The agent ran into a problem.", session: s.id)
        default: break
        }
    }

    /// A comment on lines of the diff joins the open chat's message box (after what's already written).
    func addComment(_ text: String, session id: String) {
        guard let s = sessions.first(where: { $0.id == id }), let c = activeChat(of: s) else { return }
        let draft = drafts[c.id] ?? ""
        drafts[c.id] = draft.isEmpty ? text : draft + "\n\n" + text
    }

    /// ⌘⌥L: the next session with a chat waiting on the person, after the one open (any workspace).
    func openNextNeedingYou() {
        let waiting = sessions.filter { s in !s.archived && s.chats.contains { $0.state == "needs_you" } }
        guard !waiting.isEmpty else { return }
        let start = waiting.firstIndex { $0.id == selected }.map { $0 + 1 } ?? 0
        let s = waiting[start % waiting.count]
        open(s)
        if let c = s.chats.first(where: { $0.state == "needs_you" }) { activeChat[s.id] = c.id }
    }

    /// ⌘⌥↑ / ⌘⌥↓: the session above or below in the list.
    func openNeighbour(_ list: [Sessions.Session], by step: Int) {
        guard !list.isEmpty else { return }
        let i = list.firstIndex { $0.id == selected } ?? (step > 0 ? -1 : list.count)
        let j = min(max(i + step, 0), list.count - 1)
        open(list[j])
    }

    /// ⌘W: closes a chat tab (kept in the store); a session keeps at least one chat, and a working chat stays.
    func close(_ chat: Sessions.Chat) {
        guard let s = session(of: chat), s.chats.count > 1, !chat.working else { return }
        if splitChat == chat.id { splitChat = nil }
        if activeChat[s.id] == chat.id { activeChat[s.id] = s.chats.first { $0.id != chat.id }?.id }
        act { try await $0.settings(chat: chat.id, ["hidden": true]) }
    }

    /// History: archived sessions, newest first.
    func archived(in workspace: String?) -> [Sessions.Session] {
        sessions.filter { $0.archived && (workspace == nil || $0.workspaceId == workspace || $0.workspaceId == "default") }
    }

    /// Brings an archived session back: its folder is made again on its branch, its chats where they were.
    func restore(_ s: Sessions.Session) {
        act { try await $0.unarchive(session: s.id) }
        showHistory = false
        selected = s.id
    }

    /// ⌘O: the session's folder in the person's editor (Cursor, then VS Code, else Finder).
    func openInEditor(_ s: Sessions.Session) {
        let url = URL(fileURLWithPath: s.folder)
        for id in ["com.todesktop.230313mzl4w4u92", "com.microsoft.VSCode"] {
            if let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) {
                NSWorkspace.shared.open([url], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
                return
            }
        }
        NSWorkspace.shared.open(url)
    }
}

/// A card session's card: its project's engine, the card, and whether the person holds the wheel.
struct CardTarget: Equatable {
    var project: String
    var card: String
    var handsOn = false
}

extension SessionsModel {
    /// Stop on a card's session: the turn ends and the run waits for the person (true), or Hand back to Forge (false).
    func wheel(_ chat: Sessions.Chat, take: Bool) {
        guard let t = cardTargets[chat.sessionId] else { return }
        cardTargets[chat.sessionId]?.handsOn = take
        Task {
            if let problem = await cardWheel?(t.project, t.card, take) {
                self.problem = problem
                cardTargets[chat.sessionId]?.handsOn = !take
            }
        }
    }
}
