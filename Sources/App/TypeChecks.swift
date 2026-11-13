import AppKit
import SwiftUI

/// Bigger, easier text (Omar, Nov 13): the chat reads at the session size with roomy lines, grey text is readable on
/// the dark background, one zoom scales everything and is remembered, and nothing clips or overlaps at 85% or 150%.
/// docs/design/typography.md has the scale and why.
@MainActor
extension Checks {
    static func typeChecks(_ check: (String, Bool) -> Void) {
        chatSizeChecks(check)
        contrastChecks(check)
        zoomChecks(check)
        zoomFitChecks(check)
        topBarFitChecks(check)
    }

    /// The chat body, its code and the message box use the session tokens, at Conductor's size or larger.
    static func chatSizeChecks(_ check: (String, Bool) -> Void) {
        Zoom.drawing(at: 1) {
            check("the chat body is 16 pt (0.2.42: 13), larger than Conductor's 14", TextSize.chatBody.points == 16)
            check("the chat body's lines are 1.5 apart (24 pt)", TextSize.chatBody.lineHeight == 24)
            let parts = MarkdownCache.parts("A plain line of words.\n\n```swift\nlet x = 1\n```")
            let built = RichText.build(parts, key: RichText.zoomed(MarkdownCache.key("type-check", folder: nil)))
            let text = built.text
            let font = text.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
            let style = text.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle
            check(
                "a message's words are drawn in the chat body token (\(font.map { "\($0.pointSize)" } ?? "none") pt)",
                font?.pointSize == TextSize.chatBody.points && font?.fontName == "DMSans-Regular")
            check("a message's lines are set at the chat body's line height", style?.minimumLineHeight == TextSize.chatBody.lineHeight)
            let codeAt = (text.string as NSString).range(of: "let x").location
            let code = codeAt == NSNotFound ? nil : text.attribute(.font, at: codeAt, effectiveRange: nil) as? NSFont
            check("a code block is 14 pt mono (0.2.42: 11)", code?.pointSize == TextSize.chatCode.points && TextSize.chatCode.base == 14)
            check("the message box writes at the chat body's size", (MessageBox.typing[.font] as? NSFont)?.pointSize == TextSize.chatBody.points)
            check("the Orchestrator stays compact: half a step up", TextSize.boardText.base == 13.5 && TextSize.boardMono.base == 11.5)
            check("every other screen moved one step up (body 13 to 14)", TextSize.body.base == 14 && TextSize.caption.base == 12)
        }
    }

    /// WCAG relative luminance of an sRGB colour.
    static func luminance(_ c: Color) -> Double {
        guard let s = NSColor(c).usingColorSpace(.sRGB) else { return 0 }
        func lin(_ v: CGFloat) -> Double {
            let d = Double(v)
            return d <= 0.03928 ? d / 12.92 : pow((d + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * lin(s.redComponent) + 0.7152 * lin(s.greenComponent) + 0.0722 * lin(s.blueComponent)
    }

    static func contrast(_ a: Color, _ b: Color) -> Double {
        let (x, y) = (luminance(a), luminance(b))
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }

    /// Every text colour, the greys included, reads at WCAG AA (4.5:1) on the background and on a raised surface.
    static func contrastChecks(_ check: (String, Bool) -> Void) {
        let texts: [(String, Color)] = [("text", Theme.text), ("silver", Theme.silver), ("secondary", Theme.textSec), ("muted", Theme.textMuted)]
        for (name, colour) in texts {
            for (ground, bg) in [("background", Theme.bg), ("surface", Theme.surface)] {
                let r = contrast(colour, bg)
                check("\(name) text is at least 4.5:1 on the \(ground) (\(String(format: "%.2f", r)):1)", r >= 4.5)
            }
        }
    }

    /// The zoom steps, is remembered across launches, and scales every token.
    static func zoomChecks(_ check: (String, Bool) -> Void) {
        let suite = "forge-selftest-zoom-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let zoom = Zoom(defaults: defaults)
        check("Forge starts at actual size", zoom.level == 1 && zoom.isActualSize)
        zoom.zoomIn()
        zoom.zoomIn()
        check("Zoom In twice is 125%", zoom.percent == 125)
        check("the zoom is remembered for the next launch", Zoom(defaults: defaults).percent == 125)
        for _ in 0..<10 { zoom.zoomIn() }
        check("Zoom In stops at 150%", zoom.percent == 150 && !zoom.canZoomIn)
        for _ in 0..<10 { zoom.zoomOut() }
        check("Zoom Out stops at 85%", zoom.percent == 85 && !zoom.canZoomOut)
        zoom.reset()
        check("Actual Size goes back to 100% and is remembered", zoom.percent == 100 && Zoom(defaults: defaults).percent == 100)
        let key = NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0, windowNumber: 0, context: nil, characters: "=",
            charactersIgnoringModifiers: "=", isARepeat: false, keyCode: 24)!
        check("⌘= zooms in like ⌘+", zoom.handlesKey(key) && zoom.percent == 110)
        zoom.reset()
        let all = Zoom.drawing(at: 1.5) { TextSize.all.allSatisfy { $0.points == ($0.base * 3).rounded() / 2 } }
        check("at 150% every text token is half again as big", all)
        let saved = Zoom.shared.level
        let drawn = Zoom.drawing(at: 1.5) { Zoom.shared.level }
        check("drawing at a zoom never changes the person's own zoom", drawn == 1.5 && Zoom.shared.level == saved)
        func height(_ z: Double) -> CGFloat {
            Zoom.drawing(at: z) {
                NSHostingController(rootView: Text("Zoom").font(Theme.sans(.chatBody))).sizeThatFits(in: CGSize(width: 400, height: 400)).height
            }
        }
        let (one, big) = (height(1), height(1.5))
        check("drawn text grows with the zoom (\(one) to \(big) pt tall)", big >= one * 1.4)
        liveZoomChecks(check)
    }

    /// A window that's already open redraws at the new zoom: SwiftUI text and a chat message (AppKit) both grow.
    static func liveZoomChecks(_ check: (String, Bool) -> Void) {
        let words = "A message long enough to wrap onto a second line when the chat column is only this wide, at any zoom."
        let view = VStack(alignment: .leading, spacing: 0) {
            Text("Zoom").font(Theme.sans(.body)).fixedSize().id("label")
            MessageText(text: words).frame(width: 420, alignment: .leading)
        }
        let o = Offscreen(view.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading), size: NSSize(width: 480, height: 600))
        defer {
            Zoom.shared.set(1, persist: false)
            o.close()
        }
        Zoom.shared.set(1, persist: false)
        o.settle()
        func inked() -> Int {
            // The lowest row with text on it: grows when the words grow.
            let px = o.pixels()
            let bg = px.rgb(470, 590)
            return (0..<px.height).last { y in stride(from: 0, to: 430, by: 2).contains { !Pixels.near(px.rgb($0, y), bg, 40) } } ?? 0
        }
        let before = inked()
        Zoom.shared.set(1.5, persist: false)
        o.settle()
        let after = inked()
        check("an open window redraws at a new zoom: the text grows (\(before) to \(after) pt)", after >= Int(Double(before) * 1.35))
    }

    /// The top bar never pushes past the window: nothing drawn between the window's own buttons and the anvil, or in
    /// the bar's right padding (a bar too wide is centred, so it spills both ways). Each screen, in the narrowest
    /// window, from 85% to 150% (Settings and Workflow Studio, which have room to spare, at 150%).
    static func topBarFitChecks(_ check: (String, Bool) -> Void) {
        let ready = ScreenRender.shots().first { $0.name == "20-pr-ready" }?.choices ?? SetupChoices()
        let screens: [(String, Int, String?, EngineState?)] = [
            ("Sessions", AppModel.sessionsScreen, "sessions-pr-ready", nil), ("Orchestrator", AppModel.boardScreen, "fleet", SampleBoard.state),
            ("Orchestrator with moves", AppModel.boardScreen, nil, SampleBoard.moves), ("Settings", AppModel.settingsScreen, nil, nil),
            ("Workflow Studio", AppModel.workflowScreen, nil, nil),
        ]
        // Text only grows with the zoom, so within steps that draw the same way the largest is the hardest: 100% (the
        // board's card column gives way above it), 110% ("Open session" turns to its icon above it) and 150%, plus 85%.
        for z in [0.85, 1, 1.1, 1.5] {
            Zoom.drawing(at: z) {
                for (name, screen, scene, engine) in screens where name.hasPrefix("Sessions") || name.hasPrefix("Orchestrator") || z == 1.5 {
                    let model = ScreenRender.model(for: .init(name: name, screen: screen, choices: ready, scene: scene))
                    if let engine { model.engine = engine }
                    let o = Offscreen(RootView(model: model), size: NSSize(width: 1100, height: 760), settle: 0.25)
                    let px = o.pixels()
                    o.close()
                    if let dir = ProcessInfo.processInfo.environment["FORGE_SNAPSHOTS"] {
                        let url = URL(fileURLWithPath: dir).appendingPathComponent("topbar-\(name)-\(Int(z * 100)).png")
                        try? px.rep.representation(using: .png, properties: [:])?.write(to: url)
                    }
                    let bg = px.rgb(84, 4)
                    let xs = Array(74..<94) + Array((px.width - 22)..<px.width)
                    let clear = (12..<44).allSatisfy { y in xs.allSatisfy { Pixels.near(px.rgb($0, y), bg, 30) } }
                    check("\(Int(z * 100))%: the \(name) screen fits the narrowest window (top bar clear of both edges)", clear)
                }
            }
        }
    }

    /// At 85% and 150% the Sessions screen and the Orchestrator still fit: no pane is wider than its frame at its
    /// narrowest, usual and widest width, and every pane's header line meets at one height.
    /// The panes' vertical dividers (a column in the line's colour down most of the screen), sampled every 10 rows.
    static func dividers(_ px: Pixels, _ line: (Int, Int, Int), below top: Int) -> [Int] {
        let ys = Array(stride(from: top, to: px.height, by: 10))
        let cols = (0..<px.width).filter { x in ys.filter { Pixels.near(px.rgb(x, $0), line) }.count * 100 >= ys.count * 85 }
        return cols.filter { !cols.contains($0 - 1) }
    }

    /// The first row between `from` and `to` drawn in the line's colour across 90% of x0...x1 (every 4th point).
    static func firstLine(_ px: Pixels, _ line: (Int, Int, Int), x0: Int, x1: Int, from: Int, to: Int) -> Int? {
        let xs = Array(stride(from: x0 + 3, to: x1 - 3, by: 4))
        return (from..<min(to, px.height)).first { y in xs.filter { Pixels.near(px.rgb($0, y), line) }.count * 100 >= xs.count * 90 }
    }

    static func zoomFitChecks(_ check: (String, Bool) -> Void) {
        let line = drawnBorder()
        let dir = ProcessInfo.processInfo.environment["FORGE_SNAPSHOTS"].map { URL(fileURLWithPath: $0) }
        let panelModels = ["sessions-pr-ready", "sessions-pr-failing"].map { ($0, sessionsShot($0)) }
        for z in [0.85, 1.5] {
            Zoom.drawing(at: z) {
                let pct = "\(Int(z * 100))%"
                for (scene, model) in panelModels {
                    for w in [SessionsLayout.changes.min, SessionsLayout.changes.normal, SessionsLayout.changes.max] {
                        guard let s = model.sessions.current else { continue }
                        let panel = ChangesPanel(sessions: model.sessions, session: s, width: w)
                        let wide = NSHostingController(rootView: panel).sizeThatFits(in: CGSize(width: w, height: 900)).width
                        check("\(pct) \(scene): the Changes panel fits at \(Int(w)) pt (\(Int(wide)))", wide <= w + 0.5)
                    }
                }
                for w in [SessionsLayout.sessions.min, SessionsLayout.sessions.max] {
                    let model = panelModels[0].1
                    let list = SessionList(model: model, sessions: model.sessions, list: model.sessions.sessions)
                    let wide = NSHostingController(rootView: list).sizeThatFits(in: CGSize(width: w, height: 900)).width
                    check("\(pct): the sessions list fits at \(Int(w)) pt (\(Int(wide)))", wide <= w + 0.5)
                }
                for scene in ["sessions-pr-ready", "sessions-card"] {
                    let model = sessionsShot(scene)
                    let o = Offscreen(RootView(model: model), size: NSSize(width: 1440, height: 900), settle: 0.25)
                    let px = o.pixels()
                    o.close()
                    if let dir {
                        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                        try? px.rep.representation(using: .png, properties: [:])?.write(
                            to: dir.appendingPathComponent("\(scene)-\(Int(z * 100)).png"))
                    }
                    let top = Int(Theme.barHeight) + 2
                    let cols = dividers(px, line, below: top + Int(SessionsLayout.headerHeight) + 40)
                    let edges = [0] + cols + [px.width]
                    let ys = zip(edges, edges.dropFirst()).filter { $1 - $0 > 100 }.map {
                        firstLine(px, line, x0: $0, x1: $1, from: top, to: top + Int(SessionsLayout.headerHeight) + 20)
                    }
                    let found = ys.compactMap { $0 }
                    check(
                        "\(pct) \(scene): every pane's header line sits at one height (\(ys.map { $0.map(String.init) ?? "none" }.joined(separator: ", ")))",
                        found.count == ys.count && ys.count >= 2 && Set(found).count == 1)
                }
            }
        }
    }
}
