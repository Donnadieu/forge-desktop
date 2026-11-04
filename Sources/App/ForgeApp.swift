import AppKit
import SwiftUI

/// Entry point. Check modes run before any window so CI and agents can test the app headless.
@main
enum Entry {
    static func main() {
        let args = CommandLine.arguments
        Theme.registerFonts()
        if let code = Checks.run(args) {
            exit(code)
        }
        ForgeApp.main()
    }
}

struct ForgeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        Window(AppInfo.name, id: "main") {
            RootView(model: model)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1200, height: 800)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var termSource: DispatchSourceSignal?

    func applicationDidFinishLaunching(_ notification: Notification) {
        WindowCheck.startIfAsked(CommandLine.arguments)
        // SIGTERM (the installer, the updater, logout) quits the normal way, so agents drain first.
        signal(SIGTERM, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        src.setEventHandler { AppDelegate.quitSoon() }
        src.resume()
        termSource = src
        Updater.shared.startChecking()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    /// Quits from the run loop, never from inside a main-queue block: `terminate` waits for
    /// `reply(toApplicationShouldTerminate:)`, which arrives on the main queue, so calling it from a
    /// main-queue block (a dispatch source, a @MainActor Task) deadlocks and Forge never quits.
    static func quitSoon() {
        RunLoop.main.perform(inModes: [.default, .modalPanel]) { NSApp.terminate(nil) }
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
