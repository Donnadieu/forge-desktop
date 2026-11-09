import SwiftUI

/// The disk is nearly full, or the engine stopped a card that was filling it (engine workspace/runaway-guard.ts).
/// Cards already running keep going, so the tables stay usable under it.
struct DiskNotice: View {
    let disk: EngineState.Disk

    var body: some View {
        if let words = Self.words(disk) {
            Notice(title: words.title, detail: words.detail, icon: "internaldrive") { EmptyView() }
        }
    }

    /// The notice's two lines, or nil when there's nothing to say.
    static func words(_ disk: EngineState.Disk) -> (title: String, detail: String)? {
        let free = disk.free_pct.map { "\($0)% free" } ?? "almost full"
        let waiting = "New cards start by themselves once 10% of the disk is free."
        if disk.stopped.isEmpty {
            guard disk.low_space else { return nil }
            return ("Your Mac's disk is almost full (\(free)), so agents won't take new cards.", "Cards already running keep going. \(waiting)")
        }
        let grew = disk.stopped.map { "\($0.issue_identifier) (\(size($0.grew_gb)))" }.joined(separator: ", ")
        let title =
            disk.stopped.count == 1
            ? "Forge stopped \(disk.stopped[0].issue_identifier): its folder grew by \(size(disk.stopped[0].grew_gb)) in one run."
            : "Forge stopped \(disk.stopped.count) cards that were filling the disk: \(grew)."
        var detail =
            "\(disk.stopped.count == 1 ? "It doesn't" : "They don't") start again until you move \(disk.stopped.count == 1 ? "it" : "them") to another column or press Stop, then Start. The folder is kept so you can see what was written."
        if disk.low_space { detail += " The disk is \(free), so new cards wait until 10% is free." }
        return (title, detail)
    }

    private static func size(_ gb: Double) -> String {
        gb >= 10 ? "\(Int(gb.rounded())) GB" : String(format: "%.1f GB", gb)
    }
}
