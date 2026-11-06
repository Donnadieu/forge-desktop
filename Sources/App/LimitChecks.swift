import Foundation

/// Selftest checks for usage limits on screen: the banner's words, the one fix it offers, which cards say
/// "Waiting for limit", and when macOS is told.
@MainActor
extension Checks {
    static func limitChecks(_ check: (String, Bool) -> Void) {
        let model = AppModel(preview: true)
        model.choices.worker = .claude
        model.choices.accountID = "sample-work"
        let s = SampleBoard.limited
        let frame =
            #"{"status":"running","running":[],"retrying":[{"issue_identifier":"AIT-3","attempt":1,"error":"x","waiting_for_limit":true}],"limits":[{"role":-1,"kind":"spend","reason":"spend limit, ask your admin to raise it","message":"x","link":null,"resets_at":null,"until":"2026-11-06T04:40:30.000Z","since":"2026-11-06T01:13:00.000Z"}]}"#
        let decoded = try? EngineState.decode(Data(frame.utf8))
        check("the engine's limits and waiting cards decode", decoded?.limits?.first?.kind == "spend" && decoded?.waitingForLimit == ["AIT-3"])
        let old = #"{"status":"running","running":[],"retrying":[{"issue_identifier":"AIT-3","attempt":2}]}"#
        check("an engine from before limits still decodes, with no limits", (try? EngineState.decode(Data(old.utf8)))?.limits == nil)
        check("cards waiting for a limit aren't counted as retrying", s.retryingFailures == 0 && s.waitingForLimit.count == 3)

        guard let limit = s.limits?.first else { return check("the sample has a limit", false) }
        let info = LimitInfo.make(limit, choices: model.choices, store: model.store)
        let reset = LimitInfo.date(limit.until) ?? Date()
        let title = info.title(now: reset.addingTimeInterval(-3600))
        check(
            "the banner names the provider, the account and the time: \(title)",
            title.hasPrefix("Claude Code limit reached on ConstructEase. Agents pause until ") && title.hasSuffix("M."))
        check("the banner gives the reason in plain words", info.detail.hasPrefix("Spend limit, ask your admin to raise it."))
        check(
            "another account of the same provider is offered, never switched to",
            info.fix == info.other.map { .switchTo($0) } && info.other?.name == "Personal")
        check(
            "past the time, the banner says Forge is trying again",
            info.title(now: reset.addingTimeInterval(60)).hasSuffix("Forge is trying again now."))

        var alone = model.store
        alone.accounts.removeAll { $0.provider == .claude && $0.id != model.account?.id }
        let single = LimitInfo.make(limit, choices: model.choices, store: alone)
        check("with one account, the fix is the page the error named", single.fix == .open("https://claude.ai/admin-settings/usage"))

        var unknown = limit
        unknown.resets_at = nil
        check(
            "a limit with no reset time says Forge checks again",
            LimitInfo.make(unknown, choices: model.choices, store: model.store).detail.contains("didn't say when it resets"))

        let began = LimitNotifier.changes(before: [:], now: [limit])
        check("a new limit is told once", began.began.count == 1 && began.ended.isEmpty)
        let same = LimitNotifier.changes(before: [-1: limit.since], now: [limit])
        check("the same limit isn't told again", same.began.isEmpty && same.ended.isEmpty)
        let over = LimitNotifier.changes(before: [-1: limit.since], now: [])
        check("its end is told once", over.began.isEmpty && over.ended == [-1])
    }
}
