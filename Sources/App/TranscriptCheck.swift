import AppKit
import SwiftUI

/// `Forge --transcript-check`: the long-chat budget (docs/design/sessions.md section 7). A synthetic chat of 12,000
/// turns (Omar's longest Conductor chat is 11,663 messages) is drawn in the real transcript view inside an off-screen
/// window: it must open in under half a second and stay under 300 MB; a 5,000-line diff the same. Fails over budget.
@MainActor
enum TranscriptCheck {
    static let turns = 12_000
    /// GitHub's shared Mac runners draw about 4x slower than a Mac on a desk: the budget is for the person's Mac, so CI
    /// (which sets `CI`) gets 4x the time and still catches a list that stops reusing rows (that is 20x and more).
    static let slack = ProcessInfo.processInfo.environment["CI"] == nil ? 1.0 : 4.0
    static let openBudget = 0.5 * slack
    static let fullBudget = 1.5 * slack
    static let memoryBudgetMB = 300.0

    static func run() -> Int32 {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        var failed = 0
        func ok(_ name: String, _ pass: Bool) {
            print("\(pass ? "✓" : "✗") \(name)")
            if !pass { failed += 1 }
        }
        let before = residentMB()
        let model = SessionsModel(preview: true)
        let chat = SampleSessions.chat("long", "s1", "Chat")
        let all = synthetic(turns)
        // Opening a chat loads its newest 50 turns (SessionsClient.turns); older ones arrive as the top comes near.
        let t0 = Date()
        let opened = draw(
            TranscriptView(sessions: model, chat: chat, transcript: Transcript(chatID: "long", turns: Array(all.suffix(50)), total: turns)),
            size: NSSize(width: 900, height: 800))
        let open = Date().timeIntervalSince(t0)
        // Worst case: every turn loaded (scrolled all the way back).
        let t1 = Date()
        let whole = draw(
            TranscriptView(sessions: model, chat: chat, transcript: Transcript(chatID: "long", turns: all, total: turns)),
            size: NSSize(width: 900, height: 800))
        let full = Date().timeIntervalSince(t1)
        let used = residentMB() - before
        print(String(format: "  %d-turn chat: opens in %.2f s; with every turn loaded %.2f s, +%.0f MB", turns, open, full, used))
        ok("a \(turns)-turn chat opens in under \(openBudget) s", opened && open < openBudget)
        ok("with all \(turns) turns loaded it still draws in under \(fullBudget) s", whole && full < fullBudget)
        ok("and stays under \(Int(memoryBudgetMB)) MB", used < memoryBudgetMB)
        let diff = (0..<5_000).map { i in i % 7 == 0 ? "@@ -\(i),7 +\(i),8 @@" : (i % 3 == 0 ? "+ let added\(i) = \(i)" : "  context line \(i)") }
            .joined(separator: "\n")
        let t2 = Date()
        let diffShown = draw(DiffLines(text: diff), size: NSSize(width: 400, height: 600))
        let diffTime = Date().timeIntervalSince(t2)
        print(String(format: "  5,000-line diff: first draw %.2f s", diffTime))
        ok("a 5,000-line diff draws in under \(openBudget) s", diffShown && diffTime < openBudget)
        return failed == 0 ? 0 : 1
    }

    static func synthetic(_ n: Int) -> [Sessions.Turn] {
        (1...n).map { i in
            let id = "t\(i)"
            func e(_ k: String, _ text: String, _ name: String? = nil) -> Sessions.Event {
                Sessions.Event(
                    id: "\(id)-\(k)-\(text.count)", chatId: "long", turnId: id, seq: 0, kind: k, text: text, name: name, data: nil, size: text.count,
                    ref: nil, isError: false)
            }
            return Sessions.Turn(
                id: id, chatId: "long", seq: i, userText: "Message \(i)", status: "done", added: 3, removed: 1, files: 1,
                events: [
                    e("user", "Message \(i): fix the next thing on the list and run the tests."),
                    e("tool", "Read Sources/UI/File\(i % 50).swift", "Read"),
                    e("tool", "Edited Sources/UI/File\(i % 50).swift  +3 −1", "Edit"),
                    e("tool", "Ran make test", "Bash"),
                    e("text", "Done with **step \(i)**. The tests pass and `File\(i % 50).swift` stays under 400 lines."),
                ])
        }
    }

    /// Lays the view out in an off-screen window and draws one frame; true when it drew.
    static func draw<V: View>(_ view: V, size: NSSize) -> Bool {
        let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height).background(Theme.bg))
        host.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(
            contentRect: NSRect(x: -20000, y: -20000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered,
            defer: false)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        host.layoutSubtreeIfNeeded()
        let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds)
        if let rep { host.cacheDisplay(in: host.bounds, to: rep) }
        window.close()
        return rep != nil
    }

    static func residentMB() -> Double {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size) / 4
        let r = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }
        return r == KERN_SUCCESS ? Double(info.resident_size) / 1_048_576 : 0
    }
}
