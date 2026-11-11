import Foundation

/// Deleting workspaces. With one workspace left, Settings hid Delete workspace and `deleteWorkspace` returned without
/// doing anything, so the person couldn't start from zero; a running workspace that was deleted kept its engines
/// working. Any workspace can go now: the one on screen switches away first, the last one leaves a fresh empty
/// workspace on setup's first step, its engines stop and its folders go. The sheet asks once when cards are running
/// or hold unpushed work.
@MainActor
extension Checks {
    static func workspaceDeleteChecks(_ check: (String, Bool) -> Void) {
        guard let ready = ScreenRender.shots().first(where: { $0.name == "7-orchestrator" })?.choices else {
            return check("the Orchestrator's sample setup exists", false)
        }
        // The last workspace.
        let last = AppModel(preview: true, choices: ready, screen: AppModel.boardScreen)
        guard let only = last.store.current else { return check("the sample has a workspace", false) }
        last.store.workspaces = [only]
        last.store.projects.removeAll { $0.workspaceID != only.id }
        check("Settings offers Delete on the last workspace too", SettingsScreen.offersDelete(last.store))
        wait { await last.deleteWorkspace() }
        check("the last workspace can be deleted", last.store.workspace(only.id) == nil)
        let fresh = last.store.current
        check(
            "a fresh empty workspace takes its place",
            last.store.workspaceList.count == 1 && fresh != nil && last.store.projects(in: fresh?.id).isEmpty)
        check("and setup starts from its first step", last.choices.nextScreen == 0 && last.choices.repo == nil)

        // The workspace on screen while it runs, with others beside it.
        let model = AppModel(preview: true, choices: ready, screen: AppModel.boardScreen)
        guard let shown = model.store.current, let pid = model.viewedProject else { return check("the sample shows a project", false) }
        model.store.setRunning(shown.id, true)
        model.states[pid] = SampleBoard.state
        _ = model.link(for: pid)
        let count = model.store.workspaceList.count
        wait { await model.deleteWorkspace() }
        check(
            "the workspace on screen can be deleted; another opens",
            model.store.workspace(shown.id) == nil && model.store.current?.id != shown.id && model.store.workspaceList.count == count - 1)
        check("a running workspace's engines stop and its boards are forgotten", model.states[pid] == nil && model.links[pid] == nil)
        check("its projects go with it", model.store.projects(in: shown.id).isEmpty)

        // A workspace that isn't on screen.
        guard let side = model.store.workspaceList.first(where: { $0.id != model.store.current?.id }) else {
            return check("the sample has a second workspace", false)
        }
        let onScreen = model.store.current?.id
        wait { await model.deleteWorkspace(side.id) }
        check("a workspace that isn't on screen can be deleted too", model.store.workspace(side.id) == nil)
        check("and the one on screen stays", model.store.current?.id == onScreen)

        // Asked once, in plain words, only when something would be lost.
        let calm = AppModel.deleteLead(running: 0, unpushed: 0)
        let warn = AppModel.deleteLead(running: 2, unpushed: 1)
        check("with nothing running, the sheet just says what goes", calm.contains("forgets") && !calm.contains("pushed"))
        check(
            "running cards and unpushed work are named before deleting",
            warn.contains("2 cards are being worked on") && warn.contains("1 card has work that isn't pushed"))
        check("in plain words", !warn.lowercased().contains("engine") && !warn.contains("git"))

        cleanupChecks(check)
    }

    /// The card folders' unpushed work is counted, and a deleted workspace's folders and slot files go.
    private static func cleanupChecks(_ check: (String, Bool) -> Void) {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("forge-delete-check-\(UUID().uuidString.prefix(8))")
        defer { try? fm.removeItem(at: root) }
        let cards = root.appendingPathComponent("projects/acme/workspaces")
        try? fm.createDirectory(at: cards, withIntermediateDirectories: true)
        let remote = root.appendingPathComponent("remote.git").path
        let pushed = cards.appendingPathComponent("ACME-1").path
        let local = cards.appendingPathComponent("ACME-2").path
        let dirty = cards.appendingPathComponent("ACME-3").path
        let ok = shell(
            """
            set -e
            git init -q --bare '\(remote)'
            git clone -q '\(remote)' '\(pushed)' 2>/dev/null
            cd '\(pushed)'; git config user.email t@t; git config user.name t; git config commit.gpgsign false; echo a > a; git add a; git commit -qm a; git push -q origin HEAD 2>/dev/null
            git clone -q '\(remote)' '\(dirty)' 2>/dev/null; echo b > '\(dirty)/b'
            git init -q '\(local)'; cd '\(local)'; git config user.email t@t; git config user.name t; git config commit.gpgsign false; echo c > c; git add c; git commit -qm c
            """)
        check("the cleanup check's scratch repos were made", ok)
        var found = -1
        wait { found = await WorkspaceCleanup.unpushed(cards: cards) }
        check("cards with commits no remote has, or uncommitted changes, count as unpushed", found == 2)

        let slots = root.appendingPathComponent("slots")
        try? fm.createDirectory(at: slots, withIntermediateDirectories: true)
        let keep = root.appendingPathComponent("projects/other")
        try? fm.createDirectory(at: keep, withIntermediateDirectories: true)
        let slot = slots.appendingPathComponent(WorkspaceCleanup.slotFile(root.appendingPathComponent("projects/acme")))
        let otherSlot = slots.appendingPathComponent(WorkspaceCleanup.slotFile(keep))
        fm.createFile(atPath: slot.path, contents: Data("{}".utf8))
        fm.createFile(atPath: otherSlot.path, contents: Data("{}".utf8))
        WorkspaceCleanup.remove(folders: ["projects/acme"], root: root)
        check(
            "a deleted workspace's engine folders and slot files go",
            !fm.fileExists(atPath: root.appendingPathComponent("projects/acme").path) && !fm.fileExists(atPath: slot.path))
        check("other projects' folders stay", fm.fileExists(atPath: keep.path) && fm.fileExists(atPath: otherSlot.path))
        WorkspaceCleanup.remove(folders: [nil, "", "../x", "projects/../.."], root: root)
        check("Forge's own folder is never removed", fm.fileExists(atPath: root.path) && fm.fileExists(atPath: keep.path))
    }

    /// Runs an async step to its end while the main run loop keeps turning.
    private static func wait(_ f: @escaping @MainActor () async -> Void) {
        var done = false
        Task { @MainActor in
            await f()
            done = true
        }
        let deadline = Date().addingTimeInterval(30)
        while !done && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
    }

    /// A scratch shell script for the check's own repos. True when it exits 0.
    private static func shell(_ script: String) -> Bool {
        var ok = false
        wait { ok = await Tools.run("sh", ["-c", script]).ok }
        return ok
    }
}
