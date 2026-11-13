import AppKit
import SwiftUI

/// A view drawn in a borderless window far off screen (never on the person's screen), read back pixel by pixel and
/// driven with real mouse events. Coordinates are in points from the top left, like SwiftUI's.
@MainActor
final class Offscreen {
    let window: NSWindow
    let host: NSView
    let size: NSSize

    /// `settle`: how long layout and `.task`s get before the first look (a pixel check of a static screen needs less).
    init<V: View>(_ view: V, size: NSSize, settle wait: Double = 0.5) {
        self.size = size
        let h = NSHostingView(rootView: view.frame(width: size.width, height: size.height))
        h.frame = NSRect(origin: .zero, size: size)
        h.appearance = NSAppearance(named: .darkAqua)
        NSApplication.shared.setActivationPolicy(.prohibited)
        window = NSWindow(
            contentRect: NSRect(x: -20000, y: -20000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered,
            defer: false)
        window.alphaValue = 0
        window.contentView = h
        window.orderFrontRegardless()
        host = h
        settle(wait)
    }

    func close() { window.orderOut(nil) }

    /// Lets layout and `.task`s run (GitHub's Mac runners are about 4x slower than a desk Mac).
    func settle(_ seconds: Double = 0.5) {
        let t = ProcessInfo.processInfo.environment["CI"] == nil ? seconds : seconds * 3
        RunLoop.main.run(until: Date().addingTimeInterval(t))
        host.layoutSubtreeIfNeeded()
    }

    func pixels() -> Pixels {
        let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds)!
        host.cacheDisplay(in: host.bounds, to: rep)
        return Pixels(rep: rep, scale: CGFloat(rep.pixelsWide) / host.bounds.width)
    }

    /// A real drag: press, move in steps, release, sent to the window one by one the way the system delivers a
    /// hand on the trackpad (each event numbered and timed after the last; the gesture reads both).
    func drag(from a: CGPoint, to b: CGPoint, steps: Int = 8) {
        var n = 0
        let t0 = ProcessInfo.processInfo.systemUptime
        func send(_ type: NSEvent.EventType, _ p: CGPoint) {
            n += 1
            guard
                let e = NSEvent.mouseEvent(
                    with: type, location: NSPoint(x: p.x, y: size.height - p.y), modifierFlags: [], timestamp: t0 + Double(n) * 0.016,
                    windowNumber: window.windowNumber, context: nil, eventNumber: n, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1)
            else { return }
            window.sendEvent(e)
            RunLoop.main.run(until: Date().addingTimeInterval(0.03))
        }
        send(.leftMouseDown, a)
        for i in 1...steps {
            let f = CGFloat(i) / CGFloat(steps)
            send(.leftMouseDragged, CGPoint(x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f))
        }
        send(.leftMouseUp, b)
        settle()
    }
}

/// A drawn view's pixels, read in points from the top left.
struct Pixels {
    let rep: NSBitmapImageRep
    let scale: CGFloat

    var width: Int { Int(CGFloat(rep.pixelsWide) / scale) }
    var height: Int { Int(CGFloat(rep.pixelsHigh) / scale) }

    func rgb(_ x: Int, _ y: Int) -> (Int, Int, Int) {
        let px = Int((CGFloat(x) + 0.5) * scale)
        let py = Int((CGFloat(y) + 0.5) * scale)
        guard let c = rep.colorAt(x: min(px, rep.pixelsWide - 1), y: min(py, rep.pixelsHigh - 1))?.usingColorSpace(.sRGB) else { return (0, 0, 0) }
        return (Int(c.redComponent * 255), Int(c.greenComponent * 255), Int(c.blueComponent * 255))
    }

    static func near(_ a: (Int, Int, Int), _ b: (Int, Int, Int), _ t: Int = 6) -> Bool {
        abs(a.0 - b.0) <= t && abs(a.1 - b.1) <= t && abs(a.2 - b.2) <= t
    }

    /// Columns drawn in `line` from `top` down for at least 85% of the height: the panes' vertical dividers.
    func verticalLines(_ line: (Int, Int, Int), below top: Int) -> [Int] {
        let ys = Array(stride(from: top, to: height, by: 5))
        let cols = (0..<width).filter { x in ys.filter { Pixels.near(rgb(x, $0), line) }.count * 100 >= ys.count * 85 }
        // A hairline can land on two pixel columns; keep one per line.
        return cols.filter { !cols.contains($0 - 1) }
    }

    /// The rows between x0 and x1 drawn in `line` across at least 90% of that width, from `top` down.
    func horizontalLines(_ line: (Int, Int, Int), x0: Int, x1: Int, below top: Int) -> [Int] {
        let xs = Array((x0 + 3)..<(x1 - 3))
        let rows = (top..<height).filter { y in xs.filter { Pixels.near(rgb($0, y), line) }.count * 100 >= xs.count * 90 }
        return rows.filter { !rows.contains($0 - 1) }
    }
}

/// The sidebars resize with a real drag, the Changes panel never clips at any width it can be dragged to, every
/// pane's header line sits at one height, and only the open session's row is highlighted (Omar's four bugs, Nov 12).
@MainActor
extension Checks {
    /// Theme.border as a window draws it (colour-managed, so not its hex value).
    static func drawnBorder() -> (Int, Int, Int) {
        let o = Offscreen(Rectangle().fill(Theme.border), size: NSSize(width: 8, height: 8))
        defer { o.close() }
        return o.pixels().rgb(4, 4)
    }

    static func sessionsShot(_ scene: String, width: CGFloat = 1440, height: CGFloat = 900) -> AppModel {
        let ready = ScreenRender.shots().first { $0.name == "20-pr-ready" }?.choices ?? SetupChoices()
        return ScreenRender.model(
            for: .init(name: scene, screen: AppModel.sessionsScreen, choices: ready, scene: scene, height: height, width: width))
    }

    static func paneChecks(_ check: (String, Bool) -> Void) {
        let line = drawnBorder()
        headerLineChecks(check, line)
        resizeChecks(check, line)
        panelFitChecks(check)
        rowHighlightChecks(check)
    }

    /// Bug 3: the line under each pane's header (sessions list, chat, Changes panel) sits at one shared height.
    static func headerLineChecks(_ check: (String, Bool) -> Void, _ line: (Int, Int, Int)) {
        for scene in ["sessions-pr-ready", "sessions-pr-none", "sessions-pr-failing", "sessions-pr-draft", "sessions-card", "sessions-new"] {
            let model = sessionsShot(scene)
            let o = Offscreen(RootView(model: model), size: NSSize(width: 1440, height: 900))
            let px = o.pixels()
            o.close()
            let top = Int(Theme.barHeight) + 2
            let cols = px.verticalLines(line, below: top + 150)
            let edges = [0] + cols + [px.width]
            let ys = zip(edges, edges.dropFirst()).filter { $1 - $0 > 100 }.map { px.horizontalLines(line, x0: $0, x1: $1, below: top).first }
            let found = ys.compactMap { $0 }
            check(
                "\(scene): every pane's header line sits at one height (\(ys.map { $0.map(String.init) ?? "none" }.joined(separator: ", ")))",
                found.count == ys.count && ys.count >= 2 && Set(found).count == 1)
        }
    }

    /// Bug 1: both sidebars resize with a real drag (offscreen window), stay between their limits, close when dragged
    /// far enough in, and the widths are remembered.
    static func resizeChecks(_ check: (String, Bool) -> Void, _ line: (Int, Int, Int)) {
        let model = sessionsShot("sessions-pr-ready")
        let suite = "forge-selftest-layout-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        model.sessions.layoutStore = SessionsLayout.Store(defaults: defaults)
        let o = Offscreen(RootView(model: model), size: NSSize(width: 1440, height: 900))
        defer { o.close() }
        let top = Int(Theme.barHeight) + 160
        func dividers() -> [Int] { o.pixels().verticalLines(line, below: top) }
        let start = dividers()
        check("the sessions list and the Changes panel start at their usual widths", start == [260, 1440 - 361])
        let mid = CGFloat(500)
        o.drag(from: CGPoint(x: CGFloat(1440 - 361) + 0.5, y: mid), to: CGPoint(x: CGFloat(1440 - 361) - 99.5, y: mid))
        check("dragging the Changes panel's edge widens it", dividers().last == 1440 - 461)
        check("the panel's new width is saved", Int(defaults.double(forKey: SessionsLayout.Store.rightWidth)) == 460)
        o.drag(from: CGPoint(x: 260.5, y: mid), to: CGPoint(x: 340.5, y: mid))
        check("dragging the sessions list's edge widens it", dividers().first == 340)
        o.drag(from: CGPoint(x: CGFloat(1440 - 461) + 0.5, y: mid), to: CGPoint(x: 600, y: mid))
        check("the panel stops at its widest", dividers().last == 1440 - Int(SessionsLayout.changes.max) - 1)
        o.drag(from: CGPoint(x: 340.5, y: mid), to: CGPoint(x: 175.5, y: mid))
        check("the sessions list stops at its narrowest", dividers().first == Int(SessionsLayout.sessions.min))
        let again = SessionsModel(preview: true)
        again.layoutStore = SessionsLayout.Store(defaults: defaults)
        check(
            "the widths are remembered",
            again.leftWidth == SessionsLayout.sessions.min && again.rightWidth == SessionsLayout.changes.max)
        o.drag(from: CGPoint(x: CGFloat(SessionsLayout.sessions.min) + 0.5, y: mid), to: CGPoint(x: 60, y: mid))
        check("dragged far in, the sessions list closes", !model.sessions.showSessions && dividers().count == 1)
    }

    /// Bug 2: the Changes panel's header and buttons fit at its narrowest, usual and widest width: nothing reaches its
    /// right padding (a clipped button runs to the edge), and nothing is wider than the panel.
    static func panelFitChecks(_ check: (String, Bool) -> Void) {
        let line = drawnBorder()
        let scenes = [
            "sessions-pr-draft", "sessions-pr-ready", "sessions-pr-conflicts", "sessions-pr-failing", "sessions-pr-comments", "sessions-pr-checking",
            "sessions-pr-none", "sessions-pr-empty",
        ]
        let dir = ProcessInfo.processInfo.environment["FORGE_SNAPSHOTS"].map { URL(fileURLWithPath: $0) }
        for scene in scenes {
            for w in [SessionsLayout.changes.min, SessionsLayout.changes.normal, SessionsLayout.changes.max] {
                let model = sessionsShot(scene)
                guard let s = model.sessions.current else {
                    check("\(scene) has a session open", false)
                    continue
                }
                let panel = ChangesPanel(sessions: model.sessions, session: s, width: w)
                let fits = NSHostingController(rootView: panel).sizeThatFits(in: CGSize(width: w, height: 700)).width <= w + 0.5
                let o = Offscreen(panel, size: NSSize(width: w, height: 400))
                let px = o.pixels()
                if let dir {
                    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                    try? px.rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("\(scene)-\(Int(w)).png"))
                }
                o.close()
                let bg = px.rgb(px.width - 2, 2)
                let edge = Array((px.width - 10)..<px.width)
                // The header's rows (and the status lines under it), minus the full-width lines.
                let band = (0..<Int(SessionsLayout.headerHeight) + 40).filter { y in
                    !Pixels.near(px.rgb(px.width / 2, y), line) || !Pixels.near(px.rgb(4, y), line)
                }
                let clear = band.allSatisfy { y in edge.allSatisfy { Pixels.near(px.rgb($0, y), bg, 10) } }
                check("\(scene) at \(Int(w)) pt: the header fits, nothing runs to the panel's edge", fits && clear)
            }
        }
    }

    /// Bug 4: exactly one row, the open session, has the selected look; working or idle rows have no fill, and a
    /// hovered row's look isn't the selected one.
    static func rowHighlightChecks(_ check: (String, Bool) -> Void) {
        let model = AppModel(preview: true, screen: AppModel.sessionsScreen)
        let sessions = model.sessions
        sessions.sessions = [
            SampleSessions.session("w1", "Add windowed mode and columns", repo: "a/b", branch: "x", status: "working", chats: []),
            SampleSessions.session("w2", "Serve Directory talent page", repo: "a/b", branch: "y", status: "working", chats: []),
            SampleSessions.session("i1", "Ops feedback", repo: "a/b", branch: "z", status: "idle", chats: []),
        ]
        sessions.foldedGroups = []
        func fills(selected: String?, hovered: String?) -> [(Int, Int, Int)] {
            sessions.selected = selected
            SessionList.hoveredInRender = hovered
            defer { SessionList.hoveredInRender = nil }
            let o = Offscreen(SessionList(model: model, sessions: sessions, list: sessions.sessions), size: NSSize(width: 260, height: 520))
            let px = o.pixels()
            o.close()
            // Down a column inside every row's rounded fill, left of its dot: runs that differ from the list's own colour.
            let x = 14
            let base = px.rgb(2, px.height - 120)
            var runs: [(start: Int, color: (Int, Int, Int))] = []
            var y = 100
            while y < px.height - 100 {
                let c = px.rgb(x, y)
                if !Pixels.near(c, base, 3) {
                    var end = y
                    while end < px.height, Pixels.near(px.rgb(x, end), c, 3) { end += 1 }
                    if end - y >= 30 { runs.append((y, c)) }
                    y = end
                } else {
                    y += 1
                }
            }
            return runs.map(\.color)
        }
        let plain = fills(selected: "w2", hovered: nil)
        check("only the open session's row is filled; working and idle rows aren't", plain.count == 1)
        let hovered = fills(selected: "w2", hovered: "w1")
        check(
            "a hovered row looks different from the open one",
            hovered.count == 2 && !Pixels.near(hovered[0], hovered[1], 3)
                && plain.first.map { p in hovered.filter { Pixels.near($0, p, 3) }.count == 1 } == true)
        check("with no session open, no row is filled", fills(selected: nil, hovered: nil).isEmpty)
    }
}
