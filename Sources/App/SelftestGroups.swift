import Foundation

/// The selftest's groups and how they split into shares (`Forge --selftest --part k/n`, tools/preflight.sh).
@MainActor
extension Checks {
    /// One group of selftest checks. `seconds` is what it took on a desk Mac, measured Nov 13 (`FORGE_SELFTEST_TIMES=1
    /// Forge --selftest` prints each group's time on stderr). `--part` uses it to give each share about the same time.
    struct Group {
        let name: String
        let seconds: Double
        let run: @MainActor ((String, Bool) -> Void) -> Void
    }

    /// Every group, in the order a whole selftest runs them. A new group gets a row here, with its measured seconds.
    static let groups: [Group] = [
        Group(name: "basics", seconds: 0.2, run: basicChecks),
        Group(name: "icon", seconds: 1.1, run: AppIcon.checks),
        Group(name: "board-switch", seconds: 3.6, run: boardFollowsSwitch),
        Group(name: "harness", seconds: 0.1, run: harnessChecks),
        Group(name: "tracker", seconds: 0.1, run: trackerChecks),
        Group(name: "linear-team", seconds: 0.1, run: linearTeamChecks),
        Group(name: "missing-column-setup", seconds: 0.1, run: missingColumnSetupChecks),
        Group(name: "missing-column-studio", seconds: 0.1, run: missingColumnStudioChecks),
        Group(name: "missing-column-gating", seconds: 0.1, run: missingColumnGatingChecks),
        Group(name: "parking", seconds: 0.1, run: parkingChecks),
        Group(name: "next-step", seconds: 0.1, run: nextStepChecks),
        Group(name: "skill", seconds: 1.1, run: skillChecks),
        Group(name: "workspace-name", seconds: 0.1, run: workspaceNameChecks),
        Group(name: "pr-panel", seconds: 0.1, run: prPanelChecks),
        // The panes are four groups (each draws its own screens), so no share waits on one long group.
        Group(name: "pane-headers", seconds: 18.3, run: { headerLineChecks($0, drawnBorder()) }),
        Group(name: "pane-resize", seconds: 9.8, run: { resizeChecks($0, drawnBorder()) }),
        Group(name: "pane-fit", seconds: 13.8, run: panelFitChecks),
        Group(name: "pane-rows", seconds: 1.7, run: rowHighlightChecks),
        Group(name: "move", seconds: 0.1, run: moveChecks),
        Group(name: "account", seconds: 0.1, run: accountChecks),
        Group(name: "workspace", seconds: 0.1, run: workspaceChecks),
        Group(name: "workspace-delete", seconds: 0.8, run: workspaceDeleteChecks),
        Group(name: "workflow-file", seconds: 0.1, run: workflowFileChecks),
        Group(name: "no-raw-workflow", seconds: 8.7, run: noRawWorkflowChecks),
        Group(name: "limit", seconds: 0.1, run: limitChecks),
        Group(name: "session", seconds: 0.1, run: sessionChecks),
        Group(name: "session-polish", seconds: 4.3, run: sessionPolishChecks),
        Group(name: "steer", seconds: 0.1, run: steerChecks),
        Group(name: "session-isolation", seconds: 5, run: sessionIsolationChecks),
        Group(name: "chat-render", seconds: 5, run: chatRenderChecks),
        Group(name: "workspace-setup", seconds: 0.1, run: workspaceSetupChecks),
        Group(name: "terminal", seconds: 0.2, run: terminalChecks),
        Group(name: "paste", seconds: 16.8, run: pasteChecks),
        Group(name: "copy", seconds: 20.2, run: copyChecks),
        Group(name: "composer-key", seconds: 7.3, run: composerKeyChecks),
        Group(name: "question", seconds: 40.8, run: questionChecks),
        Group(name: "open-in", seconds: 2.7, run: openInChecks),
        Group(name: "type", seconds: 21, run: typeChecks),
    ]

    /// Splits groups into `n` shares of about the same time: the longest first, each into the lightest share so far.
    /// A share keeps the whole run's order. Every group lands in exactly one share (checked in `basicChecks`).
    static func share(_ k: Int, of n: Int, from list: [Group]) -> [Group] {
        var load = Array(repeating: 0.0, count: n)
        var owner: [String: Int] = [:]
        let longestFirst = list.enumerated().sorted { ($0.element.seconds, -$0.offset) > ($1.element.seconds, -$1.offset) }
        for (_, g) in longestFirst {
            let lightest = load.indices.min { (load[$0], $0) < (load[$1], $1) } ?? 0
            load[lightest] += g.seconds
            owner[g.name] = lightest
        }
        return list.filter { owner[$0.name] == k - 1 }
    }
}
