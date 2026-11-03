import AppKit
import SwiftUI

/// Headless checks the agent can run (it can't see the screen). Used by tools/preflight.sh and CI.
///   Forge --selftest            facts about the app + the main view draws
///   Forge --version             prints the version
///   Forge --window-check <file> opens normally, writes what windows it shows to <file>, quits
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
        let renderer = ImageRenderer(content: RootView().frame(width: 720, height: 480))
        renderer.scale = 1
        let size = renderer.nsImage?.size ?? .zero
        check("the main window's view draws", size.width == 720 && size.height == 480)
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
