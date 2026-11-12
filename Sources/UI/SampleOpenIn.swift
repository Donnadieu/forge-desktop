import AppKit

/// Render mode's Open in (docs/design/open-in.md): shots 21-open-in-*.
@MainActor
extension SampleSessions {
    /// The Open in scenes: a card's session (s4) with Cursor picked, first use, just opened, failed, and side by side.
    static func openInScene(_ m: SessionsModel, _ scene: String) -> Bool {
        switch scene {
        case "sessions-open-in", "sessions-open-in-first", "sessions-open-in-opened": m.selected = "s4"
        case "sessions-open-in-failed":
            m.selected = "s4"
            OpenInModel.shared.problem["s4"] = "Cursor didn't open: the app was moved or deleted."
        case "sessions-open-in-split":
            (m.selected, m.splitChat, m.showChanges) = ("s2", "c1", false)
        default: return false
        }
        return true
    }

    /// Renders' Open in: this Mac's apps (their real icons), Cursor as the one-click app except on first use, a defaults
    /// store of their own (never the person's), and a launch that opens nothing.
    static func openInSample(_ scene: String) -> OpenInModel {
        let suite = "forge-render-open-in"
        let store = UserDefaults(suiteName: suite) ?? .standard
        store.removePersistentDomain(forName: suite)
        let m = OpenInModel(
            registry: { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) ?? Self.sampleApp($0) },
            defaults: OpenIn.Defaults(store: store), launcher: { _ in })
        m.pasteboard = nil
        if scene.hasPrefix("sessions-open-in"), scene != "sessions-open-in-first" { m.defaults.set("cursor", for: "default") }
        if scene == "sessions-open-in-opened" { m.opened["s4"] = "Opened in Cursor" }
        return m
    }

    /// Cursor, Zed and Terminal stand in when this Mac lacks them, so every render shows the same groups.
    static func sampleApp(_ id: String) -> URL? {
        ["com.todesktop.230313mzl4w4u92", "dev.zed.Zed", "com.apple.Terminal", "com.apple.finder"].contains(id)
            ? URL(fileURLWithPath: "/Applications/\(id).app") : nil
    }
}
