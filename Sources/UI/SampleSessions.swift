import Foundation

/// Render mode's sessions: the design's sample data (docs/design/sessions.md, frames a1 to a6).
@MainActor
enum SampleSessions {
    static func chat(_ id: String, _ session: String, _ title: String, state: String = "idle", context: Int = 180_000) -> Sessions.Chat {
        Sessions.Chat(
            id: id, sessionId: session, title: title, model: "opus[1m]", effort: "high", planMode: false, askBeforeChanges: false,
            state: state, contextTokens: context, contextWindow: 1_000_000, queued: 0, turns: 1)
    }

    static func session(
        _ id: String, _ title: String, repo: String, branch: String, status: String, origin: String = "person", pr: Int? = nil,
        unread: Bool = false, chats: [Sessions.Chat]
    ) -> Sessions.Session {
        Sessions.Session(
            id: id, workspaceId: "default", origin: origin, repo: repo, folder: "/tmp/\(id)", branch: branch, base: "main", title: title,
            prNumber: pr, prState: pr == nil ? nil : (status == "merged" ? "MERGED" : "OPEN"), prTitle: nil, unread: unread, archived: false,
            status: status, chats: chats, updatedAt: "")
    }

    static var all: [Sessions.Session] {
        [
            session(
                "s2", "Fix the updater crash on 0.2.22", repo: "Donnadieu/forge-desktop", branch: "donnadieu/updater-crash", status: "needs_you",
                pr: 64, unread: true, chats: [chat("c2", "s2", "Chat", state: "needs_you", context: 90_000)]),
            session(
                "s1", "Add a Sessions screen", repo: "Donnadieu/forge-desktop", branch: "donnadieu/sessions-screen", status: "working",
                chats: [chat("c1", "s1", "Build", state: "working"), chat("c1r", "s1", "Review")]),
            session(
                "s4", "AIT-3 Reject an order when the balance is too low", repo: "AI Trading Bot", branch: "forge/AIT-3", status: "working",
                origin: "card", chats: [chat("c4", "s4", "AIT-3", state: "working", context: 240_000)]),
            session(
                "s5", "AIT-5 Add a stop-loss to the momentum strategy", repo: "AI Trading Bot", branch: "forge/AIT-5", status: "working",
                origin: "card", chats: [chat("c5", "s5", "AIT-5", state: "working")]),
            session(
                "s3", "Reconnect Telegram after sleep", repo: "Donnadieu/one", branch: "donnadieu/telegram-reconnect", status: "review", pr: 318,
                chats: [chat("c3", "s3", "Chat", context: 270_000)]),
            session(
                "s6", "Write the spec checklist", repo: "Donnadieu/tandem", branch: "donnadieu/spec-checklist", status: "merged", pr: 2,
                chats: [chat("c6", "s6", "Chat")]),
        ]
    }

    static func event(_ id: String, _ turn: String, _ chat: String, _ kind: String, _ text: String, name: String? = nil, data: JSONValue? = nil)
        -> Sessions.Event
    {
        Sessions.Event(
            id: id, chatId: chat, turnId: turn, seq: 0, kind: kind, text: text, name: name, data: data, size: text.count, ref: nil, isError: false)
    }

    static func turn(_ id: String, _ chat: String, _ text: String, status: String, events: [Sessions.Event], files: Int = 0) -> Sessions.Turn {
        Sessions.Turn(
            id: id, chatId: chat, seq: 1, userText: text, status: status, added: files * 40, removed: files * 3, files: files,
            events: [event("\(id)-u", id, chat, "user", text)] + events)
    }

    static var buildTurn: Sessions.Turn {
        let t = "t1"
        return turn(
            t, "c1", "Add a Sessions screen to the workspace. Start with the list and New session; leave the Orchestrator as it is.",
            status: "working",
            events: [
                event("e1", t, "c1", "thinking", ""),
                event("e2", t, "c1", "tool", "Read Sources/UI/OrchestratorScreen.swift", name: "Read"),
                event("e3", t, "c1", "tool", "Searched TopBar", name: "Grep"),
                event("e4", t, "c1", "tool", "Edited Sources/UI/SessionsScreen.swift  +184 −0", name: "Edit"),
                event("e5", t, "c1", "tool", "Ran make lint", name: "Bash"),
                event(
                    "e6", t, "c1", "text",
                    "The list is in. Sessions group by what they need from you: **Needs you**, **Working**, **Ready for review**, **Merged**. Next I'm wiring New session to the host so Send creates the branch and the first chat."
                ),
                event("e7", t, "c1", "user", "Keep every file under 400 lines.", name: "steered"),
                event("e8", t, "c1", "text", "Splitting `SessionsScreen.swift` into the list and the composer…"),
                event("e9", t, "c1", "tool", "Editing Sources/UI/SessionList.swift", name: "Edit"),
            ])
    }

    static var questionTurn: Sessions.Turn {
        let q: JSONValue = .object([
            "requestId": .string("r1"),
            "input": .object([
                "questions": .array([
                    .object([
                        "question": .string("The crash comes from the zip being swapped while the app reads it. Which fix?"),
                        "options": .array([
                            .object([
                                "label": .string("Download to a temp file, then swap"),
                                "description": .string("Safe: the app never reads a half file."),
                            ]),
                            .object(["label": .string("Retry the read three times"), "description": .string("Smaller change, may still fail.")]),
                        ]),
                    ])
                ])
            ]),
        ])
        return turn(
            "t2", "c2", "The updater crashes on 0.2.22 when a new version lands while the app reads the zip. Find the cause and fix it.",
            status: "working",
            events: [
                event("q0", "t2", "c2", "tool", "Read Sources/EngineHost/Updater.swift", name: "Read"),
                event("q1", "t2", "c2", "tool", "Ran the updater test 20 times · 3 crashed", name: "Bash"),
                event("q2", "t2", "c2", "question", "", name: "AskUserQuestion", data: q),
            ])
    }

    static var cardTurn: Sessions.Turn {
        turn(
            "t4", "c4", "Work AIT-3: reject an order when the balance is too low.", status: "working",
            events: [
                event("k1", "t4", "c4", "tool", "Found where orders are placed: orders/place.py", name: "Grep"),
                event("k2", "t4", "c4", "tool", "Sent a helper: write the tests for low balances", name: "Task"),
                event("k3", "t4", "c4", "user", "Use the existing InsufficientFunds error, don't add a new one.", name: "steered"),
                event("k4", "t4", "c4", "text", "Using `InsufficientFunds` from `orders/errors.py`. The check goes before the broker call."),
                event("k5", "t4", "c4", "tool", "Editing orders/validate.py", name: "Edit"),
            ], files: 2)
    }

    static func fill(_ m: SessionsModel) {
        m.sessions = all
        m.selected = "s1"
        m.connected = true
        m.setTranscript(Transcript(chatID: "c1", turns: [buildTurn]))
        m.setTranscript(Transcript(chatID: "c2", turns: [questionTurn]))
        m.setTranscript(Transcript(chatID: "c4", turns: [cardTurn]))
        m.cardTargets = ["s4": CardTarget(project: "p1", card: "c3"), "s5": CardTarget(project: "p1", card: "c5")]
        m.changes["s1"] = [
            .init(path: "Sources/UI/SessionsScreen.swift", added: 184, removed: 0, status: "A"),
            .init(path: "Sources/UI/SessionList.swift", added: 96, removed: 0, status: "A"),
            .init(path: "Sources/UI/SessionFeed.swift", added: 71, removed: 0, status: "A"),
            .init(path: "Sources/UI/AppModel+Sessions.swift", added: 38, removed: 12, status: "M"),
            .init(path: "Sources/UI/Shell.swift", added: 14, removed: 9, status: "M"),
            .init(path: "Sources/UI/Theme.swift", added: 9, removed: 17, status: "M"),
        ]
        m.changes["s4"] = [
            .init(path: "orders/validate.py", added: 61, removed: 4, status: "M"),
            .init(path: "tests/test_validate.py", added: 13, removed: 0, status: "A"),
        ]
        m.pullRequests["s3"] = Sessions.PullRequest(
            number: 318, title: "Reconnect Telegram after sleep", state: "OPEN", url: "https://github.com", isDraft: false,
            checks: [.init(name: "build", state: "SUCCESS")])
        m.pullRequests["s2"] = Sessions.PullRequest(
            number: 64, title: "Fix the updater crash", state: "OPEN", url: "https://github.com", isDraft: false,
            checks: [.init(name: "app", state: "FAILURE"), .init(name: "engine", state: "SUCCESS")])
    }

    static let threads: [Sessions.ReviewThread] = [
        .init(
            id: "r1", path: "Sources/Telegram/Bridge.swift", line: 142, author: "erika", body: "Don't retry forever; cap it at 5.", url: "",
            resolved: false, outdated: false),
        .init(
            id: "r2", path: "Sources/Telegram/Bridge.swift", line: 88, author: "erika", body: "Log the reason before reconnecting.", url: "",
            resolved: false, outdated: false),
        .init(
            id: "r3", path: "Sources/App/Wake.swift", line: 31, author: "mkhan", body: "NSWorkspace.didWakeNotification fires twice on some Macs.",
            url: "",
            resolved: false, outdated: false),
        .init(
            id: "r4", path: "Tests/BridgeTests.swift", line: 12, author: "mkhan", body: "Add a test for sleep longer than the sign-in's life.",
            url: "",
            resolved: false, outdated: false),
        .init(
            id: "r5", path: "Sources/Telegram/Bridge.swift", line: 40, author: "erika", body: "Rename this to reconnectDelay.", url: "",
            resolved: false, outdated: true),
        .init(
            id: "r6", path: "Sources/App/Wake.swift", line: 12, author: "erika", body: "Typo in the comment.", url: "", resolved: true,
            outdated: false),
    ]

    /// Puts the model in the state a render shows.
    static func scene(_ m: SessionsModel, _ scene: String) {
        switch scene {
        case "sessions-new": m.composing = true
        case "sessions-card": m.selected = "s4"
        case "sessions-split":
            m.selected = "s2"
            m.splitChat = "c1"
            m.showChanges = false
        case "sessions-review":
            m.selected = "s3"
            m.reviewSheet = .init(session: "s3", number: 318, threads: threads, picked: ["r1", "r2", "r3", "r4"])
        case "sessions-import":
            m.importSheet = Sessions.ConductorPreview(
                found: true,
                repos: [
                    .init(repo: "Donnadieu/forge-desktop", sessions: 3, chats: 9, messages: 12_104),
                    .init(repo: "Donnadieu/one", sessions: 4, chats: 8, messages: 9_870),
                    .init(repo: "Donnadieu/notarc", sessions: 2, chats: 4, messages: 3_211),
                    .init(repo: "acme/rails-app", sessions: 5, chats: 11, messages: 14_203),
                ], sessions: 14, chats: 32, messages: 39_388, alreadyImported: 0)
        default: break
        }
    }
}
