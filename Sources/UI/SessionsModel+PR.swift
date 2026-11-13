import AppKit
import Foundation

/// The Changes panel's fixes (update the branch, ready for review, a hand-made PR), renaming the branch, and
/// archiving from the list with one question when something still runs (docs/design/sidebar-pr-panel.md).
extension SessionsModel {
    /// "Pull PR review comments into this chat": the threads, and which ones are ticked.
    struct ReviewSheet: Equatable {
        var session: String
        var number: Int
        var threads: [Sessions.ReviewThread]
        var picked: Set<String>
    }

    struct ArchiveAsk: Equatable {
        var session: Sessions.Session
        var title: String
        var message: String
    }

    /// GitHub works mergeability out lazily: while it says "checking", ask again after 3, 6 and 12 seconds.
    func askAgainIfChecking(_ id: String, _ pr: Sessions.PullRequest?) {
        guard pr?.status?.tone == "checking" else {
            checkingTries[id] = nil
            return
        }
        let n = checkingTries[id, default: 0]
        guard n < 3 else { return }
        checkingTries[id] = n + 1
        refreshSoon(id, after: UInt64(3 << n))
    }

    func refreshSoon(_ id: String, after seconds: UInt64) {
        Task {
            try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
            refreshSide(id)
        }
    }

    /// A tool call that may have pushed or touched the pull request (the panel looks again a moment later).
    nonisolated static func mayChangePR(_ e: Sessions.Event) -> Bool {
        guard e.kind == "tool" else { return false }
        let t = e.text.lowercased()
        return t.contains("push") || t.contains("gh pr") || t.contains("pull request")
    }

    /// Runs a pull request action, then asks GitHub again at once and five seconds later (its answer lags).
    func acted(_ s: Sessions.Session, _ f: @escaping (SessionsClient) async throws -> Void) {
        guard let client, belongs(s) else { return }
        Task {
            do { try await f(client) } catch { problem = "\(error)" }
            refreshSide(s.id)
            refreshSoon(s.id, after: 5)
        }
    }

    func merge(_ s: Sessions.Session) { acted(s) { try await $0.merge(session: s.id) } }

    func archive(_ s: Sessions.Session) {
        // An archived session is never archived again: its row and header offer Unarchive instead.
        guard !s.archived else { return }
        // Its Terminal tabs close first: their shells end with the session (Terminals.swift).
        Terminals.shared.closeAll(s.id)
        act { try await $0.archive(session: s.id) }
        if selected == s.id { selected = nil }
    }

    /// "Branch is behind main: Update".
    func update(_ s: Sessions.Session) { acted(s) { try await $0.update(session: s.id) } }

    /// "Draft: Ready for review".
    func ready(_ s: Sessions.Session) { acted(s) { try await $0.ready(session: s.id) } }

    /// "Create PR manually": the branch goes to GitHub, then GitHub's page for a new pull request opens.
    func publish(_ s: Sessions.Session) {
        acted(s) { c in
            if let url = try await c.publish(session: s.id) { await MainActor.run { _ = NSWorkspace.shared.open(url) } }
        }
    }

    func rename(_ s: Sessions.Session, to branch: String) {
        guard let client, belongs(s) else { return }
        Task {
            do {
                try await client.rename(session: s.id, branch: branch)
                renameAsk = nil
            } catch { problem = "\(error)" }
        }
    }

    /// The question archiving asks first, when something still runs: a card Forge is working, or a chat mid-turn.
    func archiveQuestion(_ s: Sessions.Session) -> ArchiveAsk? {
        if s.origin == "card", cardTargets[s.id] != nil {
            let card = s.title.split(separator: " ").first.map(String.init) ?? s.title
            return ArchiveAsk(
                session: s, title: "Archive \(card)?",
                message: "Forge is still working this card. Archiving hides it here; the card keeps running on the board.")
        }
        if s.chats.contains(where: \.working) {
            return ArchiveAsk(session: s, title: "Archive \(s.title)?", message: "The agent is still working. Archiving stops it.")
        }
        return nil
    }

    /// Archive from the list, ⌘⇧A or a sheet: asks once when something still runs.
    func requestArchive(_ s: Sessions.Session) {
        guard !s.archived else { return }
        if let ask = archiveQuestion(s) { archiveAsk = ask } else { archive(s) }
    }
}
