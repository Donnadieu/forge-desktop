import Foundation
import SwiftUI

/// One chat's transcript as the screen shows it: the latest turns first loaded, older ones on demand, and every
/// live change applied in place. Only the turn being written changes; finished turns stay as they are.
@MainActor
final class Transcript: ObservableObject {
    let chatID: String
    @Published private(set) var turns: [Sessions.Turn] = []
    @Published private(set) var total = 0
    @Published var loading = false
    var hasOlder: Bool { (turns.first?.seq ?? 1) > 1 && turns.count < total }

    init(chatID: String, turns: [Sessions.Turn] = [], total: Int? = nil) {
        self.chatID = chatID
        self.turns = turns
        self.total = total ?? turns.count
    }

    func load(_ client: SessionsClient?) async {
        guard let client, !loading else { return }
        loading = true
        defer { loading = false }
        if let t = try? await client.turns(chat: chatID) {
            turns = t.turns
            total = t.total
        }
    }

    func loadOlder(_ client: SessionsClient?) async {
        guard let client, !loading, hasOlder, let first = turns.first?.seq else { return }
        loading = true
        defer { loading = false }
        if let t = try? await client.turns(chat: chatID, before: first) {
            turns = t.turns + turns
            total = t.total
        }
    }

    func apply(_ t: Sessions.Turn) {
        if let i = turns.firstIndex(where: { $0.id == t.id }) {
            var next = t
            next.events = turns[i].events
            turns[i] = next
        } else {
            turns.append(t)
            total += 1
        }
    }

    func apply(_ e: Sessions.Event) {
        guard let i = turns.lastIndex(where: { $0.id == e.turnId }) else { return }
        if let j = turns[i].events.firstIndex(where: { $0.id == e.id }) {
            turns[i].events[j] = e
        } else {
            turns[i].events.append(e)
        }
    }

    func dropFrom(seq: Int) {
        turns.removeAll { $0.seq >= seq }
        total = turns.count
    }
}

/// The Sessions screen's model: the sessions host's connection, the sessions, which one is open, each chat's
/// transcript, and every action the screen offers. In render mode it holds sample data and never starts the host.
@MainActor
final class SessionsModel: ObservableObject {
    @Published var sessions: [Sessions.Session] = []
    @Published var selected: String?
    /// The workspace on screen (the app sets it, `show(workspace:)`): only its sessions are shown, opened or acted on.
    /// Sessions of other workspaces keep running; they just don't show here.
    @Published var workspace: String?
    /// What each workspace had open (its session and side-by-side chat), for when the person comes back to it.
    var picks: [String: (selected: String?, split: String?)] = [:]
    /// The chat shown for each session (its tab).
    @Published var activeChat: [String: String] = [:]
    /// A second chat shown side by side (any session's).
    @Published var splitChat: String?
    @Published var composing = false
    @Published var problem: String?
    @Published var busy = false
    @Published var changes: [String: [Sessions.FileChange]] = [:]
    @Published var pullRequests: [String: Sessions.PullRequest] = [:]
    @Published var openDiff: (session: String, path: String, text: String)?
    @Published var showChanges = true
    @Published var reviewSheet: ReviewSheet?
    @Published var importSheet: Sessions.ConductorPreview?
    @Published var showHistory = false
    @Published var drafts: [String: String] = [:]
    /// Messages the person sent, per chat: each one brings that chat to its latest turn.
    @Published var sent: [String: Int] = [:]
    /// Groups of the sessions list folded to their header: idle and finished ones start folded.
    @Published var foldedGroups: Set<String> = ["Idle", "Merged"]
    /// Sessions showing their Changes tab instead of a chat.
    @Published var changesTab: Set<String> = []
    /// Pictures waiting in each chat's message box.
    @Published var images: [String: [PastedImage]] = [:]
    @Published var pickerOpen = false
    @Published var connected = false

    struct ReviewSheet: Equatable {
        var session: String
        var number: Int
        var threads: [Sessions.ReviewThread]
        var picked: Set<String>
    }

    let preview: Bool
    private(set) var client: SessionsClient?
    private var live: URLSessionWebSocketTask?
    private var transcripts: [String: Transcript] = [:]
    /// Card sessions: the session's id to the card's project and card, so a message goes to that card's engine.
    @Published var cardTargets: [String: CardTarget] = [:]
    /// Set by the app: sends a message to a card's running agent; returns the problem, nil when sent.
    var steerCard: (@MainActor (String, String, String) async -> String?)?
    /// Set by the app: takes the wheel of a card (true) or hands it back (false); returns the problem, nil when done.
    var cardWheel: (@MainActor (String, String, Bool) async -> String?)?
    private var lastWatch: [[String: String]] = []
    /// The skills each session can run, cached until a skill folder changes (Core/Skills.swift).
    let skillCatalog = SkillCatalog()

    init(preview: Bool) {
        self.preview = preview
        if preview { SampleSessions.fill(self) }
    }

    func chat(_ id: String?) -> Sessions.Chat? {
        guard let id else { return nil }
        return sessions.lazy.flatMap(\.chats).first { $0.id == id }
    }

    func activeChat(of s: Sessions.Session) -> Sessions.Chat? {
        chat(activeChat[s.id]) ?? s.chats.first
    }

    func session(of chat: Sessions.Chat) -> Sessions.Session? { sessions.first { $0.id == chat.sessionId } }

    func transcript(_ chatID: String) -> Transcript {
        if let t = transcripts[chatID] { return t }
        let t = Transcript(chatID: chatID)
        transcripts[chatID] = t
        if !preview { Task { await t.load(client) } }
        return t
    }

    func setTranscript(_ t: Transcript) { transcripts[t.chatID] = t }

    // MARK: connection

    func connect() async {
        guard !preview, client == nil else { return }
        do {
            let c = try await EngineHost.sessions.ensureStarted()
            let cl = SessionsClient(port: c.port, token: c.token)
            client = cl
            sessions = try await cl.sessions()
            connected = true
            problem = nil
            live = cl.live(
                onFrame: { [weak self] f in Task { @MainActor in self?.apply(f) } },
                onClose: { [weak self] in
                    Task { @MainActor in
                        self?.client = nil
                        self?.connected = false
                        try? await Task.sleep(nanoseconds: 1_000_000_000)
                        await self?.connect()
                    }
                })
        } catch {
            problem = "Forge couldn't start its sessions: \(error)"
        }
    }

    func apply(_ f: Sessions.Frame) {
        switch f {
        case .sessions(let all): sessions = all
        case .session(let s):
            if let i = sessions.firstIndex(where: { $0.id == s.id }) { sessions[i] = s } else { sessions.insert(s, at: 0) }
        case .chat(let c):
            guard let i = sessions.firstIndex(where: { $0.id == c.sessionId }) else { return }
            if c.hidden == true { return sessions[i].chats.removeAll { $0.id == c.id } }
            notifyIfNeeded(c)
            if let j = sessions[i].chats.firstIndex(where: { $0.id == c.id }) {
                var next = c
                next.turns = next.turns ?? sessions[i].chats[j].turns
                sessions[i].chats[j] = next
            } else {
                sessions[i].chats.append(c)
            }
        case .turn(let t): transcripts[t.chatId]?.apply(t)
        case .event(let e): transcripts[e.chatId]?.apply(e)
        case .reverted(let chat, let seq): transcripts[chat]?.dropFrom(seq: seq)
        }
    }

    // MARK: actions

    func act(_ f: @escaping (SessionsClient) async throws -> Void) {
        guard let client else { return }
        Task {
            do { try await f(client) } catch { problem = "\(error)" }
        }
    }

    func open(_ s: Sessions.Session) {
        guard belongs(s) else { return }
        selected = s.id
        composing = false
        if s.unread { act { try await $0.read(session: s.id) } }
        refreshSide(s.id)
    }

    func refreshSide(_ id: String) {
        guard let client else { return }
        Task {
            if let files = try? await client.changes(session: id) { changes[id] = files }
            if let pr = try? await client.pullRequest(session: id) { pullRequests[id] = pr } else { pullRequests[id] = nil }
        }
    }

    func send(_ chat: Sessions.Chat, text: String, queue: Bool) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let pics = images[chat.id] ?? []
        guard !t.isEmpty || !pics.isEmpty, isHere(chat) else { return }
        drafts[chat.id] = ""
        sent[chat.id, default: 0] += 1
        if let target = cardTargets[chat.sessionId] {
            guard !t.isEmpty else { return }
            Task {
                if let problem = await steerCard?(target.project, target.card, t) {
                    self.problem = problem
                    drafts[chat.id] = t
                }
            }
            return
        }
        images[chat.id] = nil
        act { try await $0.send(chat: chat.id, text: t, queue: queue, images: pics.map(\.body)) }
    }

    /// Adds pictures to a chat's message box.
    func attach(_ pics: [PastedImage], to chat: Sessions.Chat) {
        guard !pics.isEmpty else { return }
        images[chat.id, default: []].append(contentsOf: pics)
    }

    /// Tells the host which cards run now (only when that changed).
    func watch(_ cards: [[String: String]]) {
        guard !preview, let client, cards != lastWatch else { return }
        lastWatch = cards
        Task { try? await client.watchCards(cards) }
    }

    func stop(_ chat: Sessions.Chat) {
        guard isHere(chat) else { return }
        act { try await $0.stop(chat: chat.id) }
    }

    func answer(_ chat: Sessions.Chat, _ e: Sessions.Event, allow: Bool, answers: [String: String]? = nil, feedback: String? = nil) {
        guard isHere(chat) else { return }
        act { try await $0.answer(chat: chat.id, event: e.id, allow: allow, answers: answers, feedback: feedback) }
    }

    func set(_ chat: Sessions.Chat, model: String? = nil, effort: String? = nil, planMode: Bool? = nil, ask: Bool? = nil) {
        var b: [String: Any] = [:]
        if let model { b["model"] = model }
        if let effort { b["effort"] = effort }
        if let planMode { b["planMode"] = planMode }
        if let ask { b["askBeforeChanges"] = ask }
        act { try await $0.settings(chat: chat.id, b) }
    }

    func revert(_ chat: Sessions.Chat, turn: Sessions.Turn) { act { try await $0.revert(chat: chat.id, turn: turn.id) } }

    /// A new chat tab in the session; without a title it's the next "Chat N".
    func newChat(in s: Sessions.Session, title: String? = nil, message: String = "") {
        let base = activeChat(of: s)
        let name = title ?? Self.newChatTitle(in: s)
        act {
            try await $0.newChat(
                session: s.id, model: base?.model ?? Sessions.defaultModel, effort: base?.effort ?? Sessions.defaultEffort, title: name,
                message: message)
        }
    }

    /// Review: a new chat in the same folder reviews the branch's changes.
    func review(_ s: Sessions.Session) { newChat(in: s, title: "Review", message: Sessions.Prompt.review) }

    /// Where a new session's branch comes from: a new one off the base (Forge names it when `name` is empty), or one
    /// that already exists.
    enum BranchChoice: Equatable {
        case new(String)
        case existing(String)
    }

    static func createBody(
        workspace: String, repo: SessionRepo, message: String, model: String, effort: String, branch: BranchChoice
    ) -> [String: Any] {
        var b: [String: Any] = [
            "workspaceId": workspace, "repo": repo.repo, "local": repo.local ?? "", "base": repo.base ?? "main", "prefix": "auto",
            "message": message, "model": model, "effort": effort, "existing": false,
        ]
        switch branch {
        case .new(let name):
            let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
            if !n.isEmpty { b["branch"] = n }
        case .existing(let name):
            b["branch"] = name
            b["existing"] = true
        }
        return b
    }

    func create(
        workspace: String, repo: SessionRepo, message: String, model: String, effort: String, branch: BranchChoice = .new(""),
        done: @escaping (Bool) -> Void
    ) {
        guard let client else { return done(false) }
        busy = true
        problem = nil
        Task {
            defer { busy = false }
            do {
                let body = Self.createBody(workspace: workspace, repo: repo, message: message, model: model, effort: effort, branch: branch)
                if let s = try await client.create(body) {
                    apply(.session(s))
                    open(s)
                }
                done(true)
            } catch {
                problem = "\(error)"
                done(false)
            }
        }
    }

    /// The branches a new session can open in this repo (fetched first), main first.
    func branches(of repo: SessionRepo) async -> [String] {
        (try? await client?.branches(repo: repo.repo, local: repo.local, base: repo.base ?? "main")) ?? []
    }

    func showDiff(_ s: Sessions.Session, _ path: String) {
        guard let client else { return }
        Task { if let d = try? await client.diff(session: s.id, path: path) { openDiff = (s.id, path, d) } }
    }

    func pullReviewComments(_ s: Sessions.Session) {
        guard let client else { return }
        Task {
            do {
                let threads = try await client.reviewThreads(session: s.id)
                let fresh = threads.filter { !$0.resolved && !$0.outdated }
                reviewSheet = ReviewSheet(session: s.id, number: s.prNumber ?? 0, threads: threads, picked: Set(fresh.map(\.id)))
            } catch { problem = "\(error)" }
        }
    }

    /// Puts the ticked review comments into the chat's message box, so the person can add a line before sending.
    func addReviewComments(to chat: Sessions.Chat) {
        guard let sheet = reviewSheet else { return }
        let picked = sheet.threads.filter { sheet.picked.contains($0.id) }
        let block = ReviewBlock.text(number: sheet.number, picked)
        let draft = drafts[chat.id] ?? ""
        drafts[chat.id] = draft.isEmpty ? block : draft + "\n\n" + block
        reviewSheet = nil
    }

    func merge(_ s: Sessions.Session) {
        guard belongs(s) else { return }
        act { try await $0.merge(session: s.id) }
    }
    func archive(_ s: Sessions.Session) {
        act { try await $0.archive(session: s.id) }
        if selected == s.id { selected = nil }
    }
}

/// Review comments as one block in the message box: file:line, reviewer, what they said, link.
enum ReviewBlock {
    static func text(number: Int, _ threads: [Sessions.ReviewThread]) -> String {
        let items = threads.map { t in
            "- \(t.place) (\(t.author)): \(t.body.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\n", with: " "))\n  \(t.url)"
        }
        return "Review comments on PR #\(number):\n" + items.joined(separator: "\n")
    }
}
