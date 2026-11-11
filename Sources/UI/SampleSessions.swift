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
                chats: [chat("c1", "s1", "Build", state: "working"), chat("c1r", "s1", "Chat 2")]),
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

    static func result(_ id: String, _ turn: String, _ chat: String, _ tool: String, _ text: String, error: Bool = false) -> Sessions.Event {
        Sessions.Event(
            id: id, chatId: chat, turnId: turn, seq: 0, kind: "tool_result", text: text, name: nil, data: nil, size: text.count, ref: tool,
            isError: error)
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

    /// The prompt Forge sends a card's agent, as it arrives in the card's session (Omar's PER-32, Nov 11).
    static let cardPrompt = """
        You are working on a Linear ticket `PER-32`.

        Continuation context:

        - This is retry attempt #1 because the ticket is still in an active state.
        - Resume from the current workspace state instead of restarting from scratch.

        ## What the assessment found

        * A Rails 8.1 prototype with **636 Minitest tests** and 33 end-to-end journeys, all run by CI.
        * The main gap is that RuboCop, Brakeman and bundler-audit are configured in `config/ci.rb` but never run in CI.

        ### Running it (from a card)

        1. **Read first.** Re-read the repo; the assessment on the card is a summary, not a substitute.
        2. Build exactly the guardrails the owner chose, in **one additive pull request**.
        3. Run `bin/rails test` before you push.

        ```sh
        bin/rubocop --parallel
        bin/brakeman --no-pager
        ```

        Every violation the structural lint grandfathers is a backlog ticket, not a silent exemption.
        """

    static var promptTurn: Sessions.Turn {
        turn(
            "t4p", "c4", cardPrompt, status: "working",
            events: [
                event("p1", "t4p", "c4", "thinking", "Hardening mode. The card names 9 guardrails; that's the scope. Map the repo first."),
                event(
                    "p2", "t4p", "c4", "text", "Hardening mode. The card names 9 specific guardrails — that's the scope. Let me map the repo first."),
                event(
                    "p3", "t4p", "c4", "tool", "Ran Map repo structure", name: "Bash", data: .object(["command": .string("ls -la && cat Gemfile")])),
                result(
                    "p3r", "t4p", "c4", "p3",
                    "total 96\ndrwxr-xr-x  24 omar  staff   768 Nov 11 app\n-rw-r--r--   1 omar  staff  2210 Nov 11 Gemfile\nsource \"https://rubygems.org\"\ngem \"rails\", \"~> 8.1\""
                ),
                event("p4", "t4p", "c4", "thinking", ""),
                event("p5", "t4p", "c4", "tool", "Read config/ci.rb", name: "Read", data: .object(["file_path": .string("config/ci.rb")])),
                event(
                    "p6", "t4p", "c4", "tool", "Edited .github/workflows/ci.yml  +2 −1", name: "Edit",
                    data: .object([
                        "file_path": .string(".github/workflows/ci.yml"), "old_string": .string("      - run: bin/rails test"),
                        "new_string": .string("      - run: bin/rubocop --parallel\n      - run: bin/rails test"),
                    ])),
                event("p6b", "t4p", "c4", "tool", "Ran Run rubocop and brakeman", name: "Bash", data: .object(["command": .string("bin/rubocop")])),
                result("p6c", "t4p", "c4", "p6b", "bin/rubocop: No such file or directory", error: true),
                event("p7", "t4p", "c4", "text", "Gems aren't installed in this fresh workspace. Installing them first."),
            ], files: 1)
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
        case "sessions-code":
            // Code coloured by its language: a Swift block in the chat and a Swift file's diff.
            m.selected = "s1"
            let t = turn(
                "t1c", "c1", "Show me how the list groups sessions.", status: "done",
                events: [
                    event(
                        "c1a", "t1c", "c1", "text",
                        "It groups by status, newest first:\n\n```swift\nstatic func groups(_ list: [Session]) -> [Group] {\n    // Needs you comes first.\n    let order = [\"needs_you\", \"working\", \"review\"]\n    return order.map { s in Group(status: s, rows: list.filter { $0.status == s }) }\n}\n```\n\nIdle and merged sessions fold away."
                    )
                ])
            m.setTranscript(Transcript(chatID: "c1", turns: [t]))
            ChangesPanel.openInRender = (
                "Sources/UI/SessionList.swift",
                "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -12,4 +12,6 @@ struct SessionList: View {\n     let list: [Sessions.Session]\n-    var title = \"Sessions\"\n+    @State private var folded: Set<String> = [\"idle\", \"merged\"]\n+    // Idle and merged groups start folded.\n     var body: some View {\n         ScrollView {"
            )
        case "sessions-tabs":
            m.selected = "s1"
            ChatTabs.hoverInRender = "c1r"
        case "sessions-changes-tab":
            SampleSessions.scene(m, "sessions-code")
            m.changesTab = ["s1"]
        case "sessions-card-long":
            // Omar's PER-32 card (Nov 11): a long branch name and the card's whole prompt as its first message.
            m.selected = "s4"
            if let i = m.sessions.firstIndex(where: { $0.id == "s4" }) {
                m.sessions[i].branch = "donnadieu86/per-32-get-donnadieuintake-workspace-ready-for-agents"
            }
            m.setTranscript(Transcript(chatID: "c4", turns: [promptTurn]))
            ToolRow.openInRender = ["p3", "p6", "p6b"]
        case "sessions-split":
            m.selected = "s2"
            m.splitChat = "c1"
            m.showChanges = false
        case "sessions-review":
            m.selected = "s3"
            m.reviewSheet = .init(session: "s3", number: 318, threads: threads, picked: ["r1", "r2", "r3", "r4"])
        case "sessions-import":
            m.importSheet = Sessions.ConductorPreview(
                found: true, repos: [.init(repo: "acme/ai-trading-bot", sessions: 3, chats: 7, messages: 9_870)],
                workspaces: [
                    .init(
                        id: "w1", repo: "acme/ai-trading-bot", title: "Reject orders over the balance", branch: "samrivera/balance-check",
                        chats: 3, messages: 4_210, imported: false),
                    .init(
                        id: "w2", repo: "acme/ai-trading-bot", title: "Momentum strategy stop-loss", branch: "samrivera/stop-loss",
                        chats: 2, messages: 3_002, imported: false),
                    .init(
                        id: "w3", repo: "acme/ai-trading-bot", title: "Backtest report", branch: "samrivera/backtest-report", chats: 2,
                        messages: 2_658, imported: false),
                    .init(
                        id: "w4", repo: "acme/ai-trading-bot", title: "Broker sandbox keys", branch: "samrivera/sandbox", chats: 1,
                        messages: 310, imported: true),
                ], sessions: 3, chats: 7, messages: 9_870, alreadyImported: 1)
        default: break
        }
    }
}
