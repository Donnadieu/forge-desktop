import Foundation

/// Facts about the app that every layer may read. Core imports Foundation only.
enum AppInfo {
    /// The one name people see: the window, the menu bar, the Dock.
    static let name = "Forge"

    /// What web requests to GitHub and Basecamp call themselves: plain, so no service log names the app
    /// (the engine sends the same, engine tracker/marks.ts).
    static let plainUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"

    /// The version from the app bundle (written from the repo's VERSION file by build.sh).
    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }
}
