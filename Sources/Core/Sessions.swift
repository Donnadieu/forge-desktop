import Foundation

/// Sessions: chats with agents inside a workspace (docs/design/sessions.md). The sessions host (the engine in
/// its sessions mode) keeps them; these are the shapes it sends, decoded as they arrive.
enum Sessions {
    struct Session: Decodable, Sendable, Equatable, Identifiable {
        var id: String
        var workspaceId: String
        /// "person", "card" or "import".
        var origin: String
        var repo: String
        var folder: String
        var branch: String
        var base: String
        var title: String
        var prNumber: Int?
        var prState: String?
        var prTitle: String?
        var unread: Bool
        var archived: Bool
        /// "working", "needs_you", "review", "merged", "idle" or "archived".
        var status: String
        var chats: [Chat]
        var updatedAt: String

        var origins: String {
            switch origin {
            case "card": return "Started by Forge"
            case "import": return "Imported"
            default: return "Started by you"
            }
        }
    }

    struct Chat: Decodable, Sendable, Equatable, Identifiable {
        var id: String
        var sessionId: String
        var title: String
        var model: String
        var effort: String
        var planMode: Bool
        var askBeforeChanges: Bool
        /// "idle", "working", "needs_you", "stopped" or "failed".
        var state: String
        var contextTokens: Int
        var contextWindow: Int
        var queued: Int?
        /// The messages waiting for the turn to end, oldest first: shown in the transcript at once.
        var queue: [String]? = nil
        var turns: Int?
        /// Closed (⌘W): kept in the store, not shown.
        var hidden: Bool? = nil

        var working: Bool { state == "working" || state == "needs_you" }
        var contextPercent: Int { contextWindow > 0 ? min(100, contextTokens * 100 / contextWindow) : 0 }
    }

    struct Turn: Decodable, Sendable, Equatable, Identifiable {
        var id: String
        var chatId: String
        var seq: Int
        var userText: String
        /// "working", "done", "stopped", "failed" or "interrupted".
        var status: String
        var added: Int
        var removed: Int
        var files: Int
        var events: [Event]
    }

    struct Event: Decodable, Sendable, Equatable, Identifiable {
        var id: String
        var chatId: String
        var turnId: String
        var seq: Int
        /// user, text, thinking, tool, tool_result, permission, question, plan, note or error.
        var kind: String
        var text: String
        var name: String?
        var data: JSONValue?
        var size: Int
        var ref: String?
        var isError: Bool

        /// A steer's state: "sending" until the agent has read it, then "delivered". Nil for older events.
        var delivery: String? { data?["delivery"]?.string }
    }

    struct FileChange: Decodable, Sendable, Equatable, Identifiable {
        var path: String
        var added: Int
        var removed: Int
        var status: String
        var id: String { path }
    }

    struct PullRequest: Decodable, Sendable, Equatable {
        struct Check: Decodable, Sendable, Equatable {
            var name: String
            var state: String
            /// Its page on GitHub (the run's log).
            var url: String? = nil
            /// A rule on the base branch needs it to pass.
            var required: Bool? = nil
            var failing: Bool {
                ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].contains(state.uppercased())
            }
        }
        /// The one status the Changes panel shows, worked out by the host from GitHub's answer (engine
        /// sessions/github.ts `mergeStatus`): a tone for its colour, one sentence, and the one fix (nil: nothing to press).
        struct Status: Decodable, Sendable, Equatable {
            /// ready, blocked, failing, waiting, checking, merged or closed.
            var tone: String
            var label: String
            var action: String?
        }
        var number: Int
        var title: String
        var state: String
        var url: String
        var isDraft: Bool
        var checks: [Check]
        var base: String? = nil
        var unresolved: Int? = nil
        var threadsByPath: [String: Int]? = nil
        var status: Status? = nil
        /// The checks that hold the merge up: the required ones when the repo marks any, else every failing one.
        var failing: [Check] {
            let required = checks.contains { $0.required == true }
            return checks.filter { $0.failing && (!required || $0.required == true) }
        }
        func comments(on path: String) -> Int { threadsByPath?[path] ?? 0 }
    }

    struct ReviewThread: Decodable, Sendable, Equatable, Identifiable {
        var id: String
        var path: String
        var line: Int?
        var author: String
        var body: String
        var url: String
        var resolved: Bool
        var outdated: Bool
        var place: String { line.map { "\(path):\($0)" } ?? path }
    }

    struct ConductorRepo: Decodable, Sendable, Equatable, Identifiable {
        var repo: String
        var sessions: Int
        var chats: Int
        var messages: Int
        var id: String { repo }
    }

    /// One Conductor workspace; it comes over as one session.
    struct ConductorWorkspace: Decodable, Sendable, Equatable, Identifiable {
        var id: String
        var repo: String
        var title: String
        var branch: String
        var chats: Int
        var messages: Int
        var imported: Bool
    }

    struct ConductorPreview: Decodable, Sendable, Equatable {
        var found: Bool
        var repos: [ConductorRepo]
        /// Each Conductor workspace of the repo asked for (engines before the scoped import don't send it).
        var workspaces: [ConductorWorkspace]?
        var sessions: Int
        var chats: Int
        var messages: Int
        var alreadyImported: Int
    }

    /// One live change from the host.
    enum Frame: Sendable {
        case sessions([Session])
        case session(Session)
        case chat(Chat)
        case turn(Turn)
        case event(Event)
        case reverted(chatId: String, seq: Int)
    }

    private struct RawFrame: Decodable {
        var type: String
        var sessions: [Session]?
        var session: Session?
        var chat: Chat?
        var queued: Int?
        var queue: [String]?
        var turn: TurnHead?
        var event: Event?
        var chatId: String?
        var seq: Int?
    }

    /// A turn as a live frame sends it (no events: those come one by one).
    struct TurnHead: Decodable, Sendable {
        var id: String
        var chatId: String
        var seq: Int
        var userText: String
        var status: String
        var added: Int
        var removed: Int
        var files: Int
    }

    static func decodeFrame(_ data: Data) -> Frame? {
        guard let f = try? JSONDecoder().decode(RawFrame.self, from: data) else { return nil }
        switch f.type {
        case "sessions": return f.sessions.map(Frame.sessions)
        case "session": return f.session.map(Frame.session)
        case "chat":
            guard var c = f.chat else { return nil }
            c.queued = f.queued
            c.queue = f.queue
            return .chat(c)
        case "turn":
            guard let t = f.turn else { return nil }
            return .turn(
                Turn(
                    id: t.id, chatId: t.chatId, seq: t.seq, userText: t.userText, status: t.status, added: t.added,
                    removed: t.removed, files: t.files, events: []))
        case "event": return f.event.map(Frame.event)
        case "reverted":
            guard let c = f.chatId, let s = f.seq else { return nil }
            return .reverted(chatId: c, seq: s)
        default: return nil
        }
    }

    /// The models a chat can pick, Claude Code's names first, as the picker shows them.
    static let models: [(id: String, name: String)] = [
        ("opus[1m]", "Opus 5.5 · 1M"), ("opus", "Opus 5.5"), ("sonnet[1m]", "Sonnet 5.5 · 1M"), ("sonnet", "Sonnet 5.5"), ("haiku", "Haiku"),
    ]
    static let efforts: [(id: String, name: String)] = [
        ("low", "Low"), ("medium", "Medium"), ("high", "High"), ("xhigh", "Extra high"), ("max", "Max"),
    ]
    /// Omar's Conductor default: Opus with the 1M context on high effort.
    static let defaultModel = "opus[1m]"
    static let defaultEffort = "high"

    static func modelName(_ id: String) -> String {
        models.first { $0.id == id }?.name ?? id
    }

    static func effortName(_ id: String) -> String {
        efforts.first { $0.id == id }?.name ?? id
    }

    /// What the one-click actions send to the chat.
    enum Prompt {
        /// What Create PR sends the agent, shaped like Conductor's create-PR prompt: the agent makes the PR in the chat,
        /// where the person sees each step, using the repo's own PR skill or template when there is one.
        static func createPR(base: String, branch: String? = nil, draft: Bool = false) -> String {
            let on = branch.map { "The current branch is \($0). " } ?? ""
            let how = draft ? "`gh pr create --draft --base \(base)` to open the PR as a draft" : "`gh pr create --base \(base)` to open the PR"
            return """
                Create a PR

                \(on)The target branch is origin/\(base).

                Follow these steps to create a PR:

                - If you have any skills related to creating PRs, invoke them now; their instructions take precedence over \
                these. If the repo has a pull request template (such as .github/pull_request_template.md), fill it in.
                - Run `git status` to check for uncommitted changes. If there are any, review them with `git diff` and commit \
                them, following any instructions about commit messages.
                - If the branch has no upstream or has unpushed commits, push with `git push -u origin HEAD`.
                - Review everything the branch changes with `git diff origin/\(base)...HEAD`.
                - Use \(how). Keep the title under 80 characters and the description \
                under five sentences unless told otherwise, and describe every change on the branch, not only this chat's.
                - Reply with the pull request's link.

                If any of these steps fail, ask the user for help.
                """
        }

        static func fixErrors(_ failing: [PullRequest.Check], number: Int) -> String {
            let names = failing.map(\.name).joined(separator: ", ")
            return """
                These checks fail on PR #\(number): \(names). Read their logs with `gh pr checks \(number)` and \
                `gh run view --log-failed`, fix the cause, commit and push.
                """
        }

        /// "Conflicts with main: Resolve".
        static func resolveConflicts(base: String) -> String {
            """
            This branch has conflicts with \(base). Run `git fetch origin` and `git merge origin/\(base)`, resolve every \
            conflict keeping what both sides meant, run the tests, then commit and push.
            """
        }

        static let review = """
            Review the changes on this branch against its base as a strict senior reviewer: correctness, edge cases, \
            tests, naming, and anything that would block a merge. List each finding with file:line and what to change. \
            Don't edit files.
            """
    }
}

/// Any JSON value (tool input, question options), kept as it came.
enum JSONValue: Decodable, Sendable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else {
            self = .object(try c.decode([String: JSONValue].self))
        }
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    var string: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    var array: [JSONValue] {
        if case .array(let a) = self { return a }
        return []
    }

    var bool: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }
}
