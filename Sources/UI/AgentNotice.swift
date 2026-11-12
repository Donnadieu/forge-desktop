import AppKit
import UserNotifications

/// Agent notifications (Omar, Nov 12): when a chat stops working, one chime and one macOS notification, unless the
/// person is looking at that session with Forge in front, or switched them off (one switch in Settings, on by
/// default). A click opens that session, its own workspace first. No sound picker: always the same chime.
struct AgentNotice: Equatable {
    var title: String
    var body: String
    var session: String

    /// What a chat's change of state tells the person, if anything. Pure.
    static func decide(old: Sessions.Chat?, new: Sessions.Chat, session s: Sessions.Session, looking: Bool, on: Bool) -> AgentNotice? {
        guard on, !looking, let old, old.working, old.state != new.state else { return nil }
        switch new.state {
        case "needs_you": return AgentNotice(title: "\(s.title) needs you", body: "The agent is waiting for your answer.", session: s.id)
        case "idle": return AgentNotice(title: "\(s.title) is done", body: "The agent finished its turn.", session: s.id)
        case "failed": return AgentNotice(title: "\(s.title) stopped", body: "The agent ran into a problem.", session: s.id)
        default: return nil
        }
    }
}

@MainActor
final class AgentNotifier {
    static let shared = AgentNotifier()
    /// The chime: macOS's Glass, played once per notice (the notification itself stays silent, so it never sounds twice).
    static let chimeName = "Glass"

    /// Checks replace these; the person gets the real ones.
    var sink: ((AgentNotice) -> Void)?
    var chime: () -> Void = { NSSound(named: AgentNotifier.chimeName)?.play() }
    var enabled: () -> Bool = {
        let saved = (try? Data(contentsOf: SetupStore.file)).flatMap { try? JSONDecoder().decode(SetupStore.self, from: $0) }
        return saved?.agentNotificationsOn ?? true
    }
    var front: () -> Bool = { NSApp?.isActive == true }

    func post(_ n: AgentNotice) {
        chime()
        if let sink { return sink(n) }
        LimitNotifier.shared.post(content: Self.content(for: n))
    }

    static func content(for n: AgentNotice) -> UNMutableNotificationContent {
        let c = UNMutableNotificationContent()
        c.title = n.title
        c.body = n.body
        c.sound = nil
        c.userInfo = ["session": n.session]
        return c
    }
}

extension SessionsModel {
    /// A chat that stopped working: the notice, when the person isn't looking at it.
    func notifyIfNeeded(_ next: Sessions.Chat) {
        let n = AgentNotifier.shared
        guard !preview || n.sink != nil, let s = sessions.first(where: { $0.id == next.sessionId }) else { return }
        let looking = n.front() && current?.id == s.id
        guard let notice = AgentNotice.decide(old: chat(next.id), new: next, session: s, looking: looking, on: n.enabled()) else { return }
        n.post(notice)
    }
}
