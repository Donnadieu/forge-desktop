import Foundation

/// One guardrail the repo assessment proposes (a formatter, a linter, an agent guide…).
struct HarnessGuardrail: Codable, Equatable, Hashable, Identifiable, Sendable {
    var id: String
    var title: String
    var why: String
    var recommended: Bool?
}

/// Harness engineering (getting a repo ready for agents) for one repo, kept on this Mac in `setup.json`
/// (`SetupChoices.harness`, keyed by repo): whether the repo was read, which guardrails were proposed, which
/// went into a card, and which landed. Every field is optional so any older record still loads.
struct HarnessRecord: Codable, Equatable, Sendable {
    /// The read-only assessment ran and answered.
    var assessed: Bool?
    /// What it proposed.
    var proposed: [HarnessGuardrail]?
    /// Guardrails ticked and sent in the latest card.
    var picked: [String]?
    /// Guardrails that landed: a card's pull request merged.
    var applied: [String]?
    /// The latest card: its Linear identifier (ENG-12) and link.
    var card: String?
    var cardURL: String?
    /// The latest card's pull request, and whether it merged.
    var pr: Int?
    var merged: Bool?
    /// With no record, what Forge found in the repo itself ("AGENTS.md", "a pre-commit hook").
    var found: [String]?

    enum Status: String, Equatable, Sendable {
        case notStarted = "Not started"
        case partly = "Partly done"
        case done = "Done"
    }

    /// Where one proposed guardrail stands.
    enum Item: Equatable, Sendable { case done, inCard, open }

    private var landedIDs: Set<String> { Set(applied ?? []) }

    var status: Status {
        if merged == true {
            // A merged pull request found in the repo, with no list of what was proposed: the repo is done.
            guard let proposed, !proposed.isEmpty else { return .done }
            let wanted = proposed.filter { $0.recommended != false }.map(\.id)
            return Set(wanted).isSubset(of: landedIDs) ? .done : .partly
        }
        if assessed == true || card != nil || !landedIDs.isEmpty || !(found ?? []).isEmpty { return .partly }
        return .notStarted
    }

    func item(_ id: String) -> Item {
        if landedIDs.contains(id) { return .done }
        if merged != true, (picked ?? []).contains(id) { return .inCard }
        return .open
    }

    /// The proposed guardrails that can still be picked: not landed and not waiting in an open card.
    var left: [HarnessGuardrail] { (proposed ?? []).filter { item($0.id) == .open } }

    /// One plain line under the status: how far along the repo is.
    var line: String {
        let proposedCount = proposed?.count ?? 0
        let landed = (proposed ?? []).filter { landedIDs.contains($0.id) }.count
        let waiting = (proposed ?? []).filter { item($0.id) == .inCard }.count
        switch status {
        case .notStarted:
            return "Not read yet."
        case .done:
            return proposedCount > 0 ? "\(landed) of \(proposedCount) guardrails in place." : "Its guardrails pull request merged."
        case .partly:
            if proposedCount == 0, let f = found, !f.isEmpty { return "Has " + f.joined(separator: " and ") + "." }
            var parts = ["\(landed) of \(proposedCount) guardrails in place"]
            if waiting > 0, let card { parts.append("\(waiting) in \(card)") }
            if waiting == 0, card == nil, landed == 0 { return "Read, no card made yet." }
            return parts.joined(separator: " · ") + "."
        }
    }

    /// The pull request line, when there is one.
    var prLine: String? {
        if let pr { return merged == true ? "Pull request #\(pr) merged" : "Pull request #\(pr) open" }
        if let card, merged != true { return "\(card) has no pull request yet" }
        return nil
    }

    /// The assessment answered: keep what it proposed (guardrails that already landed stay landed).
    mutating func read(_ guardrails: [HarnessGuardrail]) {
        assessed = true
        proposed = guardrails
    }

    /// A card was made for these guardrails.
    mutating func sent(card id: String, url: String, picked ids: [String]) {
        card = id
        cardURL = url
        picked = ids
        pr = nil
        merged = false
    }

    /// The card's pull request merged: what it carried has landed.
    mutating func landed(pr number: Int) {
        pr = number
        merged = true
        applied = Array(landedIDs.union(picked ?? [])).sorted()
    }

    /// The card's pull request was closed without merging: its guardrails can be picked again.
    mutating func closed(pr number: Int) {
        pr = number
        merged = false
        picked = nil
    }
}

extension SetupChoices {
    /// The current repo's harness record (an empty one when nothing is known yet).
    var harnessHere: HarnessRecord { repo.flatMap { harness?[$0] } ?? HarnessRecord() }

    mutating func setHarness(_ r: HarnessRecord, for repo: String) {
        var all = harness ?? [:]
        all[repo] = r
        harness = all
    }

    /// Whether a setup step is done, for the step list when changing settings (5 = harness engineering).
    func stepDone(_ step: Int) -> Bool {
        switch step {
        case 0: return trackerUser != nil
        case 1: return boardSlug != nil && columnsReady
        case 2: return githubLogin != nil && signing != nil
        case 3: return repo != nil && repoChecked
        case 4: return worker != nil && workerChecked
        case 5: return harnessHere.status == .done
        default: return false
        }
    }
}
