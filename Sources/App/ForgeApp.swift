import AppKit
import SwiftUI

/// Entry point. Check modes run before any window so CI and agents can test the app headless.
@main
enum Entry {
    static func main() {
        let args = CommandLine.arguments
        if let code = Checks.run(args) {
            exit(code)
        }
        ForgeApp.main()
    }
}

struct ForgeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        Window(AppInfo.name, id: "main") {
            RootView()
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        WindowCheck.startIfAsked(CommandLine.arguments)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    /// Quitting drains the engine first: running agents get the engine's drain window, then it stops.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Task {
            await EngineHost.shared.stop()
            await MainActor.run { NSApp.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }
}
