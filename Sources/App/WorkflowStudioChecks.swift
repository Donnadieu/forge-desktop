import AppKit
import SwiftUI
import Vision

/// Omar's call (Nov 11): the workflow file is Forge's alone. No screen shows it or edits it; settings reach it only
/// through their own controls (Workflow Studio's switches, Settings), and Forge writes the file. Every screen is drawn
/// in a window far off screen and its words are read back the way a person sees them.
@MainActor
extension Checks {
    static func noRawWorkflowChecks(_ check: (String, Bool) -> Void) {
        guard let ready = ScreenRender.shots().first(where: { $0.name == "7-orchestrator" })?.choices else {
            return check("the Orchestrator's sample setup exists", false)
        }
        // Every screen after setup, drawn tall enough that nothing hides below the fold, then read back.
        var offered: [Int] = []
        var shown: [Int] = []
        var studio: [String] = []
        for screen in AppModel.boardScreen...AppModel.sessionsScreen {
            let lines = Self.readScreen(RootView(model: AppModel(preview: true, choices: ready, screen: screen)))
            if lines.contains(where: Self.namesRawFile) { offered.append(screen) }
            if lines.contains(where: Self.rawFileLine) { shown.append(screen) }
            if screen == AppModel.workflowScreen { studio = lines }
        }
        check("no screen offers the workflow file, to edit or to read (\(offered))", offered.isEmpty)
        check("no screen shows the workflow file's text (\(shown))", shown.isEmpty)
        let kept = ["Triage", "QA", "Human Review", "Merging", "Keep Forge invisible", "Default provider", "Save workflow"]
        let missing = kept.filter { w in !studio.contains { $0.contains(w) } }
        check("Workflow Studio keeps its stage switches, Keep Forge invisible and roles (\(missing))", !studio.isEmpty && missing.isEmpty)

        studioSaveChecks(ready, check)
    }

    /// The words on a screen, as a person reads them: drawn far off screen, then read back with Vision.
    static func readScreen<V: View>(_ view: V) -> [String] {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let size = NSSize(width: 1200, height: 1800)
        let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height))
        host.frame = NSRect(origin: .zero, size: size)
        host.appearance = NSAppearance(named: .darkAqua)
        let window = NSWindow(
            contentRect: NSRect(x: -20000, y: -20000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered,
            defer: false)
        window.alphaValue = 0
        window.contentView = host
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        settle()
        host.layoutSubtreeIfNeeded()
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return [] }
        host.cacheDisplay(in: host.bounds, to: rep)
        guard let image = rep.cgImage else { return [] }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    }

    /// What Workflow Studio saves reaches the file Forge writes, and a file someone edited by hand in 0.2.23 to 0.2.32
    /// keeps the settings the app doesn't know.
    static func studioSaveChecks(_ ready: SetupChoices, _ check: (String, Bool) -> Void) {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("studio-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let url = home.appendingPathComponent("WORKFLOW.md")
        func text() -> String { (try? String(contentsOf: url, encoding: .utf8)) ?? "" }
        func active() -> String { text().components(separatedBy: "\n").first { $0.hasPrefix("  active_states:") } ?? "" }

        var c = ready
        (c.stagesOff, c.agentsAtOnce, c.invisible, c.branchPrefix) = (["QA"], 6, true, "omar/")
        do { try EngineSettings.writeWorkflow(c, home: home) } catch { return check("Forge writes the workflow file (\(error))", false) }
        check("a Studio save turns QA off in the file", !active().isEmpty && !active().contains("\"QA\"") && active().contains("\"Todo\""))
        check("and sets agents at once", text().contains("  max_concurrent_agents: 6"))
        check("and Keep Forge invisible with its branch prefix", text().contains("marks:\n  invisible: true\n  branch_prefix: \"omar/\""))

        // A file edited by hand before the editor was removed: an own setting and an own line stay.
        let legacy =
            text().replacingOccurrences(of: "  max_turns: 20", with: "  max_turns: 20\n  my_own_setting: 7") + "\nAlways run the linter first.\n"
        try? legacy.write(to: url, atomically: true, encoding: .utf8)
        let mark = home.appendingPathComponent("workflow-versions/edited")
        try? FileManager.default.createDirectory(at: mark.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: mark.path, contents: Data())
        (c.stagesOff, c.agentsAtOnce, c.invisible, c.branchPrefix) = ([], 3, nil, nil)
        try? EngineSettings.writeWorkflow(c, home: home)
        check(
            "the next Studio save keeps settings Forge doesn't know, and own lines",
            text().contains("  my_own_setting: 7") && text().contains("Always run the linter first."))
        check(
            "and still applies the switches",
            active().contains("\"QA\"") && text().contains("  max_concurrent_agents: 3") && !text().contains("marks:"))
    }

    /// Words that offer the raw file: its name, or the editor's and viewer's buttons.
    static func namesRawFile(_ s: String) -> Bool {
        let l = s.lowercased()
        return ["workflow file", "workflow.md", "view workflow", "undo last save", "saved versions"].contains { l.contains($0) }
    }

    /// A line of the file itself (its settings), which no screen draws.
    static func rawFileLine(_ s: String) -> Bool {
        ["active_states", "max_concurrent_agents", "project_slug", "terminal_states", "skills_dir"].contains { s.contains($0) }
    }
}
