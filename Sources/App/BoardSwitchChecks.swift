import AppKit
import SwiftUI

/// The Orchestrator follows the project on screen. Opening another workspace from the Orchestrator's own top bar keeps
/// the Orchestrator on screen, so SwiftUI keeps the same view: a plain `.task` never ran again and the new project's
/// board was never asked for ("Reading your board…" forever). Drawn in a real window off screen, because only a
/// window runs `.task`.
@MainActor
extension Checks {
    static func boardFollowsSwitch(_ check: (String, Bool) -> Void) {
        guard let ready = ScreenRender.shots().first(where: { $0.name == "7-orchestrator" })?.choices else {
            return check("the Orchestrator's sample setup exists", false)
        }
        let model = AppModel(preview: true, choices: ready, screen: AppModel.boardScreen)
        var side = ready
        (side.projectID, side.projectSlug, side.projectName) = ("p9", "side-project", "Side project")
        let personal = model.store.addWorkspace(name: "Personal", color: "green")
        guard let sideID = SetupStore.projectID(side), let firstID = SetupStore.projectID(ready) else {
            return check("the sample projects have ids", false)
        }
        model.store.projects.append(
            ProjectRecord(id: sideID, trackerID: side.connection, name: "Side project", repo: side.repo, workspaceID: personal.id, choices: side))

        let window = offscreen(RootView(model: model))
        defer { window.orderOut(nil) }
        settle()
        check("the Orchestrator asks for the board of the project on screen", model.boardRequests == [firstID])
        Task { await model.open(workspace: personal.id) }
        settle()
        check("opening another workspace keeps the Orchestrator on screen", model.screen == AppModel.boardScreen && model.viewedProject == sideID)
        check("and asks for that workspace's board too, instead of reading forever", model.boardRequests == [firstID, sideID])
        Task { await model.open(workspace: model.store.workspaceList[0].id) }
        settle()
        check("going back asks for the first board again", model.boardRequests == [firstID, sideID, firstID])

        // No board and no reason after the wait: the screen says so and offers Try again.
        model.engine = nil
        model.engineProblem = nil
        var late = false
        Task {
            await model.watchBoard(after: .milliseconds(20))
            late = model.boardLate
        }
        settle()
        check("a board that never comes is said out loud", late)
        let line = OrchestratorScreen.lateLine("AI Trading Bot")
        check("in plain words", line.contains("hasn't heard back") && !line.contains("Error"))
        check(
            "with what Try again does",
            OrchestratorScreen.noticeDetail(line, signedOutLine: nil, appProblem: nil, lateLine: line)?.contains("Try again") == true)
        Task { await model.open(workspace: personal.id) }
        settle()
        check("opening another workspace clears it", !model.boardLate)
        model.engine = SampleBoard.state
        Task {
            await model.watchBoard(after: .milliseconds(20))
            late = model.boardLate
        }
        settle()
        check("a board that came stays quiet", !late)

        let limit = OrchestratorScreen.plainProblem(
            "Forge couldn't read the board from GitHub Issues: GitHub said: API rate limit exceeded for user ID 22755987.")
        check("GitHub's rate limit is said in plain words", limit.contains("hourly limit") && !limit.contains("user ID"))
        check("other problems are left as the engine said them", OrchestratorScreen.plainProblem("Linear answered 502.") == "Linear answered 502.")
    }

    static func offscreen<V: View>(_ view: V) -> NSWindow {
        // No Dock icon and nothing on the person's screen: far off screen and see-through.
        NSApplication.shared.setActivationPolicy(.prohibited)
        let size = NSSize(width: 1200, height: 800)
        let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height))
        host.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(
            contentRect: NSRect(x: -20000, y: -20000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered,
            defer: false)
        window.alphaValue = 0
        window.contentView = host
        window.orderFrontRegardless()
        return window
    }

    /// Lets SwiftUI lay out and run its tasks.
    static func settle() { RunLoop.main.run(until: Date().addingTimeInterval(0.6)) }
}
