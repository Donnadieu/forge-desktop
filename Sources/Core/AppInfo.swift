import Foundation

/// Facts about the app that every layer may read. Core imports Foundation only.
enum AppInfo {
    /// The one name people see: the window, the menu bar, the Dock.
    static let name = "Forge"

    /// The version from the app bundle (written from the repo's VERSION file by build.sh).
    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }
}
