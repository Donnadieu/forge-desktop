import SwiftUI
import UserNotifications

/// Usage limits on screen: when an intelligence provider account hits its usage, spend or rate limit, the engine
/// parks its cards until the reset (engine orchestrator/usage-limits.ts). The Orchestrator says so in one banner,
/// with a one-tap switch to another account of that provider when there is one (never by itself), the cards say
/// "Waiting for limit", and macOS gets one notification when it starts and one when work goes on.
struct LimitInfo: Equatable {
    let limit: EngineState.Limit
    /// The limited account, and another of the same provider to switch to (if any).
    let account: AIAccount?
    let other: AIAccount?

    /// The limit's account: the role's for a role (`SetupChoices.roleAccounts` order), else the project's own.
    static func make(_ l: EngineState.Limit, choices c: SetupChoices, store: SetupStore) -> LimitInfo {
        let roles = c.roleAccounts(store)
        let a = l.role >= 0 && l.role < roles.count ? roles[l.role].account : store.activeAccount(c)
        let other = a.flatMap { a in store.accounts(for: a.provider).first { $0.id != a.id } }
        return LimitInfo(limit: l, account: a, other: other)
    }

    var provider: String { account?.provider.name ?? "Your intelligence provider" }
    var until: Date? { Self.date(limit.until) }

    /// "Claude Code limit reached on Work. Agents pause until 11:40 PM."
    func title(now: Date = Date()) -> String {
        let on = account.map { " on \($0.name)" } ?? ""
        guard let u = until, u > now else { return "\(provider) limit reached\(on). Forge is trying again now." }
        return "\(provider) limit reached\(on). Agents pause until \(Self.time(u, now: now))."
    }

    /// "Spend limit, ask your admin to raise it. Waiting cards pick up again by themselves."
    var detail: String {
        let reason = limit.reason.prefix(1).uppercased() + limit.reason.dropFirst()
        let when =
            limit.resets_at == nil
            ? "\(provider) didn't say when it resets, so Forge checks again then."
            : "Waiting cards pick up again by themselves, with none of their retries used."
        return "\(reason). \(when)"
    }

    /// The one fix: switch to another account of the provider, else the page the error named.
    enum Fix: Equatable {
        case switchTo(AIAccount)
        case open(String)
    }
    var fix: Fix? {
        if let other { return .switchTo(other) }
        return limit.link.map { .open($0) }
    }

    static func date(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        return ISO8601DateFormatter.withFraction.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    /// "11:40 PM" today, "Tue 3:00 PM" this week, "Nov 10, 3:00 PM" later.
    static func time(_ d: Date, now: Date = Date()) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        let cal = Calendar.current
        if cal.isDate(d, inSameDayAs: now) {
            f.dateFormat = "h:mm a"
        } else if d.timeIntervalSince(now) < 6 * 86400 {
            f.dateFormat = "EEE h:mm a"
        } else {
            f.dateFormat = "MMM d, h:mm a"
        }
        return f.string(from: d)
    }
}

/// The Orchestrator's banner for one limited account (the `Notice` look, an hourglass instead of the warning).
struct LimitBanner: View {
    let info: LimitInfo
    let switchTo: (AIAccount) -> Void
    let open: (String) -> Void

    var body: some View {
        Notice(title: info.title(), detail: info.detail, icon: "hourglass") {
            switch info.fix {
            case .switchTo(let other):
                Button("Switch to \(other.name)") { switchTo(other) }
                    .buttonStyle(ForgeButton(kind: .primary, large: true))
                    .help("Agents start again on \(other.name). Forge restarts its engine.")
                    .padding(.leading, 26)
            case .open(let link):
                Button("Open \(info.provider) usage") { open(link) }
                    .buttonStyle(ForgeButton(kind: .secondary, icon: "arrow.up.right", large: true))
                    .padding(.leading, 26)
            case nil:
                EmptyView()
            }
        }
    }
}

/// A card waiting for its account's limit: the pill the tables show instead of its stage.
struct LimitPill: View {
    var body: some View { Pill(text: "Waiting for limit", tone: .amber, dot: Theme.heat) }
}

extension EngineState {
    /// Cards waiting for a usage limit (not retrying a failure).
    var waitingForLimit: Set<String> { Set((retrying ?? []).filter { $0.waiting_for_limit == true }.map(\.issue_identifier)) }
    /// Cards retrying a failure.
    var retryingFailures: Int { (retrying ?? []).filter { $0.waiting_for_limit != true }.count }
}

extension AppModel {
    /// The on-screen project's limits, each with its account.
    var limitInfos: [LimitInfo] { (engine?.limits ?? []).map { LimitInfo.make($0, choices: choices, store: store) } }

    /// Switches the limited role (or the project) to another account of the same provider, then restarts the engine
    /// so the waiting cards go again on it. Only ever from the person's tap.
    func switchAccount(_ info: LimitInfo, to other: AIAccount) async {
        if info.limit.role < 0 {
            choices.accountID = other.id
            choices.worker = other.worker
        } else {
            let roles = choices.roleAccounts(store)
            guard info.limit.role < roles.count else { return }
            let role = roles[info.limit.role].choice.role
            choices.roles = choices.roles?.map { $0.role == role ? RoleChoice(role: role, accountID: other.id, model: $0.model) : $0 }
        }
        save(restarts: false)
        guard !preview else { return }
        await link.connect(restart: true)
    }
}

/// One macOS notification when an account's limit starts and one when its cards go on, per project.
@MainActor
final class LimitNotifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = LimitNotifier()
    /// Project id → the limits it had last time (role → when it began).
    private var seen: [String: [Int: String]] = [:]
    private var asked = false

    /// What changed between two looks at a project: limits that began and roles whose limit ended. Pure.
    static func changes(before: [Int: String], now: [EngineState.Limit]) -> (began: [EngineState.Limit], ended: [Int]) {
        let began = now.filter { before[$0.role] != $0.since }
        let roles = Set(now.map(\.role))
        return (began, before.keys.filter { !roles.contains($0) }.sorted())
    }

    func observe(project id: String, state s: EngineState, model: AppModel) {
        guard !model.preview else { return }
        let now = s.limits ?? []
        let before = seen[id] ?? [:]
        seen[id] = Dictionary(now.map { ($0.role, $0.since) }, uniquingKeysWith: { a, _ in a })
        let (began, ended) = Self.changes(before: before, now: now)
        guard !began.isEmpty || (!ended.isEmpty && s.isRunning) else { return }
        let choices = model.viewedProject == id ? model.choices : (model.store.runChoices(id, live: model.choices) ?? model.choices)
        let project = model.store.project(id)?.name ?? choices.projectName ?? "your project"
        for l in began {
            let info = LimitInfo.make(l, choices: choices, store: model.store)
            post(info.title(), "\(info.detail) (\(project))")
        }
        if s.isRunning, !ended.isEmpty {
            post("Agents are back at work", "The usage limit is over in \(project): cards picked up again.")
        }
    }

    private func post(_ title: String, _ body: String) {
        let center = UNUserNotificationCenter.current()
        let send = {
            let c = UNMutableNotificationContent()
            c.title = title
            c.body = body
            center.add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
        }
        if asked { return send() }
        asked = true
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in send() }
    }

    /// Shown even while Forge is the app in front (macOS hides a front app's notifications otherwise).
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}
