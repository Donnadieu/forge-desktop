import AppKit
import SwiftUI

/// Headless checks the agent can run (it can't see the screen). Used by tools/preflight.sh and CI.
///   Forge --selftest            facts about the app + the main view draws
///   Forge --version             prints the version
///   Forge --window-check <file> opens normally, writes what windows it shows to <file>, quits
///   Forge --engine-check        starts the bundled engine in a scratch folder and proves start/watch/stop
@MainActor
enum Checks {
    static func run(_ args: [String]) -> Int32? {
        if args.contains("--version") {
            print(AppInfo.version)
            return 0
        }
        if args.contains("--selftest") {
            return selftest()
        }
        if args.contains("--engine-check") {
            return EngineCheck.run()
        }
        if let i = args.firstIndex(of: "--worker-check"), i + 1 < args.count {
            return SetupProbe.worker(args[i + 1], model: i + 2 < args.count ? args[i + 2] : nil)
        }
        if let i = args.firstIndex(of: "--github-check") {
            return SetupProbe.github(repo: i + 1 < args.count ? args[i + 1] : nil)
        }
        if let i = args.firstIndex(of: "--render-screens"), i + 1 < args.count {
            return ScreenRender.run(into: args[i + 1])
        }
        return nil
    }

    static func selftest() -> Int32 {
        var failed = 0
        func check(_ name: String, _ ok: Bool) {
            print("\(ok ? "✓" : "✗") \(name)")
            if !ok { failed += 1 }
        }
        check("the app is called Forge", AppInfo.name == "Forge")
        check("the version comes from the bundle", AppInfo.version != "dev")
        let renderer = ImageRenderer(content: RootView(model: AppModel(preview: true)).frame(width: 720, height: 560))
        renderer.scale = 1
        let size = renderer.nsImage?.size ?? .zero
        check("the main window's view draws", size.width == 720 && size.height == 560)
        check("every pipeline column is missing from an empty team", Pipeline.missing(existing: []).count == 10)
        check(
            "a new Linear team misses six columns (Triage, AI Review, QA, Human Review, Rework, Merging)",
            Pipeline.missing(existing: ["Backlog", "Todo", "In Progress", "Done", "Canceled"]).map(\.name)
                == ["Triage", "AI Review", "QA", "Human Review", "Rework", "Merging"])
        check("column names match whatever their case and spacing", Pipeline.missing(existing: Pipeline.names.map { $0.uppercased() }).isEmpty)
        check("setup starts at the Linear screen", SetupChoices().nextScreen == 0)
        let expired = #"{"type":"result","is_error":true,"result":"Failed to authenticate: OAuth session expired"}"#
        check(
            "a Claude login that exits 0 but can't answer fails the check",
            WorkerCheck.claudeOutcome(.init(status: 0, out: expired, err: ""))
                == .fails("Claude Code said: Failed to authenticate: OAuth session expired"))
        let answered = #"{"type":"result","is_error":false,"result":"ready"}"#
        check("a Claude answer passes the check", WorkerCheck.claudeOutcome(.init(status: 0, out: answered, err: "")) == .works)
        let codexOK = #"{"type":"item.completed","item":{"type":"agent_message","text":"ready"}}"#
        check("a Codex answer passes the check", WorkerCheck.codexOutcome(.init(status: 0, out: codexOK, err: "")) == .works)
        let codexBad = #"{"type":"turn.failed","error":{"message":"unauthorized"}}"#
        check(
            "a failed Codex turn fails the check",
            WorkerCheck.codexOutcome(.init(status: 1, out: codexBad, err: "")) == .fails("Codex said: unauthorized"))
        print(failed == 0 ? "selftest: all passed" : "selftest: \(failed) failed")
        return failed == 0 ? 0 : 1
    }
}

/// Proves the real app opens a window titled Forge. Runs inside a normal launch.
@MainActor
enum WindowCheck {
    static func startIfAsked(_ args: [String]) {
        guard let i = args.firstIndex(of: "--window-check"), i + 1 < args.count else { return }
        let out = args[i + 1]
        // A check launch stays out of the person's way: no Dock icon, no focus, see-through window.
        NSApp.setActivationPolicy(.accessory)
        NotificationCenter.default.addObserver(forName: NSWindow.didUpdateNotification, object: nil, queue: .main) { note in
            (note.object as? NSWindow)?.alphaValue = 0
        }
        let activity = ProcessInfo.processInfo.beginActivity(options: .userInitiated, reason: "window check")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            let titles = NSApp.windows.map(\.title).filter { !$0.isEmpty }
            let line = titles.contains(AppInfo.name) ? "ok \(titles)" : "fail \(titles)"
            try? line.write(toFile: out, atomically: true, encoding: .utf8)
            ProcessInfo.processInfo.endActivity(activity)
            NSApp.terminate(nil)
        }
    }
}
