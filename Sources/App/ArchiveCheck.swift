import AppKit
import SwiftUI
import Vision

/// `Forge --archive-check`: archive and unarchive through the real Sessions screen (Omar, Nov 13: an archived session
/// offered only Archive again, "already archived", and never came back). The real sessions host runs in a scratch
/// folder (`FORGE_HOME`, with `FORGE_CLAUDE_COMMAND` set to the stand-in agent); the screen is drawn in an off-screen
/// window and driven with real mouse and key events. It proves: the row's hover button archives, the session moves to
/// Archived and its folder is put away; an archived row offers Unarchive and never Archive (hover, right-click, ⌘⇧A);
/// opening it shows it read-only with Unarchive in its header; Unarchive brings it back to its group with its folder,
/// branch and chat; each state survives a relaunch of the host; and a session made from the person's own checkout
/// comes back from that checkout.
@MainActor
enum ArchiveCheck {
    static func run() -> Int32 {
        setvbuf(stdout, nil, _IONBF, 0)
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        AgentNotifier.shared.sink = { _ in }
        AgentNotifier.shared.chime = {}
        var failed = 0
        let t0 = Date()
        func ok(_ name: String, _ pass: Bool) {
            print(
                "\(pass ? "✓" : "✗") \(name)"
                    + (ProcessInfo.processInfo.environment["FORGE_ARCHIVE_TIMES"] != nil
                        ? String(format: " (%.1f s)", Date().timeIntervalSince(t0)) : ""))
            if !pass { failed += 1 }
        }
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("forge-archive-check-\(UUID().uuidString.prefix(8))")
        defer { try? FileManager.default.removeItem(at: scratch) }
        guard let local = repo(in: scratch) else {
            ok("a scratch checkout with an origin", false)
            return 1
        }
        guard let first = connect() else {
            ok("the sessions host starts and the screen connects", false)
            return 1
        }
        var sessions = first
        // A first run after a build starts the bundled engine cold: give it time, and say why if it fails.
        let made = wait(120) { () -> Sessions.Session?? in
            do {
                return try await sessions.client?.create([
                    "workspaceId": "default", "repo": "acme/archive", "local": local.path, "base": "main", "prefix": "sam",
                    "message": "hello", "model": "haiku", "effort": "low",
                ])
            } catch {
                print("  the host said: \(error)")
                return nil
            }
        }
        guard let made = (made ?? nil) ?? nil, let chat = made.chats.first else {
            ok("a session is made from the person's own checkout", false)
            return 1
        }
        let id = made.id
        ok("a session is made from the person's own checkout", FileManager.default.fileExists(atPath: made.folder))
        _ = until(20) { (wait { (try? await sessions.client?.turns(chat: chat.id))?.turns.first?.status } ?? nil) == "done" }
        _ = until { sessions.sessions.first { $0.id == id }?.status == "idle" }
        sessions.foldedGroups = []

        // Archive from the row's hover button, with a real click.
        var screen = Screen(sessions, hovering: id)
        let idleRow = screen.row(made.title)
        ok("the idle session's row is on screen", idleRow != nil)
        screen.shot("1-idle-hovered")
        if let idleRow { screen.click(screen.hoverButton(idleRow)) }
        ok("the row's hover button archives it", until { sessions.sessions.first { $0.id == id }?.archived == true })
        ok("the folder is put away", until { !FileManager.default.fileExists(atPath: made.folder) })
        ok("it moves to the Archived group", group(of: id, in: sessions) == SessionList.archivedTitle)

        // An archived row offers Unarchive, never Archive: on the same screen, as the person sees it right after.
        screen.settle(1)
        screen.shot("2-archived")
        let archivedRow = screen.row(made.title)
        ok("the archived row is on screen", archivedRow != nil)
        let menu = archivedRow.flatMap { Checks.rightClickMenu(at: $0, in: screen.window) }
        let items = menu?.items.map(\.title) ?? []
        ok("right-clicking an archived row offers Unarchive", items.contains("Unarchive"))
        ok("and never Archive", !items.isEmpty && !items.contains("Archive"))
        if let archivedRow { screen.click(archivedRow) }
        ok("clicking an archived row opens it", until { sessions.selected == id })
        screen.settle(1)
        screen.shot("3-archived-open")
        let center = screen.words(in: .center)
        ok("it opens read-only, with Unarchive in its header", center.contains { $0.contains("Unarchive") })
        ok("and no message box", !center.contains { $0.contains("Message the agent") })
        ok("its chat is still there", center.contains { $0.contains("hello") })
        screen.press(shiftCommand: "a", code: 0)
        ok(
            "⌘⇧A on the open archived session never archives it again",
            sessions.problem == nil && sessions.sessions.first { $0.id == id }?.archived == true)

        // Still the same screen: the row's hover button (the mouse never left it) brings it back.
        if let archivedRow { screen.click(screen.hoverButton(archivedRow)) }
        ok("the archived row's hover button unarchives it, there and then", until(20) { sessions.sessions.first { $0.id == id }?.archived == false })
        if let p = sessions.problem { print("  the screen said: \(p)") }
        ok(
            "it goes back to Idle, with its folder on its branch",
            until { group(of: id, in: sessions) == "Idle" } && branch(of: made.folder) == made.branch)
        screen.settle(1)
        screen.shot("3b-back")
        if let row = screen.row(made.title) { screen.click(screen.hoverButton(row)) }
        ok("and its row archives it again", until { sessions.sessions.first { $0.id == id }?.archived == true })
        screen.close()

        // It stays archived after a relaunch.
        guard let again = relaunch(sessions) else {
            ok("the host starts again", false)
            return 1
        }
        sessions = again
        sessions.foldedGroups = []
        ok("after a relaunch it's still archived", sessions.sessions.first { $0.id == id }?.archived == true)

        // Unarchive from the hover button on the archived row.
        screen = Screen(sessions, hovering: id)
        screen.shot("4-archived-hovered")
        if let row = screen.row(made.title) { screen.click(screen.hoverButton(row)) }
        ok("the archived row's hover button unarchives it", until(20) { sessions.sessions.first { $0.id == id }?.archived == false })
        ok("with no problem shown", sessions.problem == nil)
        if let p = sessions.problem { print("  the screen said: \(p)") }
        ok("it goes back to its group (Idle)", until { group(of: id, in: sessions) == "Idle" })
        ok("its folder is back, on its branch", branch(of: made.folder) == made.branch)
        let turns = wait { (try? await sessions.client?.turns(chat: chat.id))?.turns.map(\.userText) } ?? nil
        ok("its chat is kept", turns == ["hello"])
        screen.close()
        guard let third = relaunch(sessions) else {
            ok("the host starts again", false)
            return 1
        }
        sessions = third
        ok("after a relaunch it's still back", sessions.sessions.first { $0.id == id }?.archived == false)

        // The header's Unarchive brings it back too.
        _ = wait { try? await sessions.client?.archive(session: id) }
        _ = until { sessions.sessions.first { $0.id == id }?.archived == true }
        sessions.selected = id
        screen = Screen(sessions)
        ok("the header's Unarchive is a real button", screen.clickWords("Unarchive", in: .center))
        ok("and it unarchives", until(20) { sessions.sessions.first { $0.id == id }?.archived == false })
        screen.close()
        _ = wait { await EngineHost.sessions.stop(grace: 5) }
        return failed == 0 ? 0 : 1
    }

    // MARK: the screen

    /// The Sessions screen in an off-screen window, wide enough for its three panes.
    @MainActor
    final class Screen {
        let o: Offscreen
        let sessions: SessionsModel
        var window: NSWindow { o.window }
        enum Pane { case list, center }

        /// `hovering`: the row drawn with the mouse over it (an off-screen window gets no hover from the system).
        init(_ sessions: SessionsModel, hovering: String? = nil) {
            self.sessions = sessions
            SessionList.hoveredInRender = hovering
            defer { SessionList.hoveredInRender = nil }
            o = Offscreen(SessionsScreen(model: AppModel(preview: true), sessions: sessions), size: NSSize(width: 1440, height: 900), settle: 1)
        }

        func close() { o.close() }

        /// `FORGE_ARCHIVE_SHOTS=<folder>` keeps a picture of each step, to look at when a check fails.
        func shot(_ name: String) {
            guard let dir = ProcessInfo.processInfo.environment["FORGE_ARCHIVE_SHOTS"] else { return }
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? o.pixels().rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: dir + "/\(name).png"))
        }
        func settle(_ s: Double = 0.5) { o.settle(s) }

        var listWidth: CGFloat { sessions.leftWidth }

        /// Every line Vision reads in one pane, with its middle (window points, bottom left). Reading one pane, not the
        /// whole window, keeps each look short.
        func lines(in pane: Pane) -> [(String, NSPoint)] {
            settle()
            guard let host = window.contentView, let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return [] }
            host.cacheDisplay(in: host.bounds, to: rep)
            guard let image = rep.cgImage else { return [] }
            let split = listWidth / host.bounds.width
            let roi = pane == .list ? CGRect(x: 0, y: 0, width: split, height: 1) : CGRect(x: split, y: 0, width: 1 - split, height: 1)
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.regionOfInterest = roi
            try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
            return (request.results ?? []).compactMap { r in
                guard let c = r.topCandidates(1).first else { return nil }
                // Vision's box is a share of the region it read, from its bottom left.
                let x = roi.minX + r.boundingBox.midX * roi.width
                return (c.string, NSPoint(x: x * host.bounds.width, y: r.boundingBox.midY * host.bounds.height))
            }
        }

        func words(in pane: Pane) -> [String] { lines(in: pane).map(\.0) }

        /// A row's title in the list.
        func row(_ title: String) -> NSPoint? { lines(in: .list).first { $0.0.contains(title) }?.1 }

        /// The hovered row's button (Archive, or Unarchive on an archived row), at the row's right edge.
        func hoverButton(_ title: NSPoint) -> NSPoint { NSPoint(x: listWidth - 8 - 12 - 11, y: title.y - 2) }

        /// A real click: press and release.
        func click(_ p: NSPoint) {
            NSApp.discardEvents(matching: [.leftMouseUp, .leftMouseDown], before: nil)
            func mouse(_ type: NSEvent.EventType, _ n: Int) -> NSEvent? {
                NSEvent.mouseEvent(
                    with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                    context: nil, eventNumber: n, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0)
            }
            if let down = mouse(.leftMouseDown, 8101), let up = mouse(.leftMouseUp, 8102) {
                NSApp.postEvent(up, atStart: false)
                window.sendEvent(down)
                if let left = NSApp.nextEvent(matching: .leftMouseUp, until: Date(), inMode: .default, dequeue: true) { window.sendEvent(left) }
            }
            settle()
        }

        func clickWords(_ words: String, in pane: Pane) -> Bool {
            guard let p = lines(in: pane).first(where: { $0.0.contains(words) })?.1 else { return false }
            click(p)
            return true
        }

        func press(shiftCommand c: String, code: UInt16) {
            if let e = Checks.keyboardEvent(code, down: true, flags: [.command, .shift]) { _ = window.performKeyEquivalent(with: e) }
            settle(1)
        }
    }

    // MARK: helpers

    /// The group a session's row sits in on the list.
    static func group(of id: String, in sessions: SessionsModel) -> String? {
        SessionList.sections(
            sessions.sessions(in: nil), archived: sessions.archived(in: nil), folded: [], search: "", selected: nil
        ).first { $0.rows.contains { $0.id == id } }?.title
    }

    /// A model connected to the real host, as the app makes it (without touching the person's saved layout).
    static func connect() -> SessionsModel? {
        let s = SessionsModel(preview: false, remembersLayout: false)
        _ = wait(60) { await s.connect() }
        return s.connected ? s : nil
    }

    /// Quits the host and connects a new screen to a new one, as a relaunch of the app does.
    static func relaunch(_ old: SessionsModel) -> SessionsModel? {
        old.disconnect()
        _ = wait { await EngineHost.sessions.stop(grace: 5) }
        return connect()
    }

    static func branch(of folder: String) -> String? { SessionsCheck.currentBranch(of: folder) }

    /// A checkout of the person's own (with an origin), the kind a new session starts from.
    static func repo(in scratch: URL) -> URL? { SessionsCheck.scratchCheckout(in: scratch) }

    /// Runs async work on the main actor while the run loop keeps turning (the screen draws, events arrive).
    static func wait<T>(_ seconds: Double = 30, _ f: @escaping @MainActor () async -> T) -> T? {
        let box = WaitBox<T>()
        Task { @MainActor in
            box.value = await f()
            box.done = true
        }
        let end = Date().addingTimeInterval(seconds)
        while !box.done && Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
        return box.value
    }

    final class WaitBox<T> {
        var value: T?
        var done = false
    }

    static func until(_ seconds: Double = 10, _ cond: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if cond() { return true }
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        return cond()
    }
}
