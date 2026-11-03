import AppKit
import SwiftUI

/// `Forge --render-screens <folder>`: draws every screen with sample data into PNGs, the way the real window
/// shows them (real controls, not a snapshot of SwiftUI's drawing). Never touches Linear, GitHub or the Keychain.
@MainActor
enum ScreenRender {
    struct Shot {
        let name: String
        let screen: Int
        var choices = SetupChoices()
        var engine: EngineState?
        var scene: String?
    }

    static func shots() -> [Shot] {
        var linked = SetupChoices()
        linked.linearUser = "Sam Rivera"
        linked.linearOrg = "Acme"
        return [
            Shot(name: "1-linear-key", screen: 0),
            Shot(name: "1-linear-connected", screen: 0, choices: linked),
            Shot(name: "2-project", screen: 1, choices: linked),
        ] + extraShots(linked)
    }

    static func run(into folder: String) -> Int32 {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let dir = URL(fileURLWithPath: folder)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var failed = 0
        for shot in shots() {
            let model = AppModel(preview: true, choices: shot.choices, screen: shot.screen)
            model.engine = shot.engine
            model.sample.scene = shot.scene
            let ok = render(RootView(model: model), size: NSSize(width: 960, height: 680), to: dir.appendingPathComponent("\(shot.name).png"))
            print("\(ok ? "✓" : "✗") \(shot.name)")
            if !ok { failed += 1 }
        }
        let detailModel = AppModel(preview: true, screen: AppModel.boardScreen)
        let held = SampleBoard.state.cards.first { $0.agent != nil }!
        let ok = render(
            CardDetail(model: detailModel, card: held) {}, size: NSSize(width: 620, height: 560),
            to: dir.appendingPathComponent("8-card-detail.png"))
        print("\(ok ? "✓" : "✗") 8-card-detail")
        if !ok { failed += 1 }
        return failed == 0 ? 0 : 1
    }

    static func render<V: View>(_ view: V, size: NSSize, to url: URL) -> Bool {
        let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height))
        host.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(
            contentRect: NSRect(x: -20000, y: -20000, width: size.width, height: size.height),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        window.orderFrontRegardless()
        // Let `.task` loaders and layout settle.
        RunLoop.main.run(until: Date().addingTimeInterval(0.8))
        host.layoutSubtreeIfNeeded()
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return false }
        host.cacheDisplay(in: host.bounds, to: rep)
        window.orderOut(nil)
        guard let png = rep.representation(using: .png, properties: [:]) else { return false }
        return (try? png.write(to: url)) != nil
    }
}
