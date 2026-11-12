import AppKit
import SwiftUI

/// Selftest checks for workspace setup (Omar, Nov 12): the files a new session gets, its setup and cleanup scripts,
/// the workspace's environment with secrets kept in the Keychain only, and agent notifications. Written before the
/// code; each failed first (docs/design/workspace-settings.md).
@MainActor
extension Checks {
    static func workspaceSetupChecks(_ check: (String, Bool) -> Void) {
        envChecks(check)
        setupPayloadChecks(check)
        agentNoticeChecks(check)
    }

    static func envChecks(_ check: (String, Bool) -> Void) {
        let secrets = MemorySecrets()
        let item = WorkspaceEnv.item(workspace: "w1", key: "STRIPE_KEY")
        let rows = [
            EnvRow(key: "RAILS_ENV", value: "development", secret: false),
            EnvRow(key: "STRIPE_KEY", value: "sk_live_selftest_abc", secret: true),
        ]
        let saved = WorkspaceEnv.save(rows, workspace: "w1", old: [], secrets: secrets)
        var w = Workspace(id: "w1", name: "Acme")
        w.setup = WorkspaceSetup(copy: ["config/master.key"], setupScript: "bin/setup", cleanupScript: nil, env: saved)
        let json = (try? JSONEncoder().encode(w)).map { String(decoding: $0, as: UTF8.self) } ?? ""
        check("a secret variable's value is never written into store.json", !json.contains("sk_live_selftest_abc") && json.contains("STRIPE_KEY"))
        check("a secret variable's value goes to the Keychain under the workspace's own item", secrets.get(item) == "sk_live_selftest_abc")
        check(
            "agents and terminals get every value, the secret read back from the Keychain",
            WorkspaceEnv.values(saved, workspace: "w1", secrets: secrets) == ["RAILS_ENV": "development", "STRIPE_KEY": "sk_live_selftest_abc"])
        let reopened = EnvRow.rows(saved)
        check("a saved secret shows masked when the screen opens again", reopened.first { $0.key == "STRIPE_KEY" }?.shown == WorkspaceEnv.mask)
        check("a plain value shows as it is", reopened.first { $0.key == "RAILS_ENV" }?.shown == "development")
        let again = WorkspaceEnv.save(reopened, workspace: "w1", old: saved, secrets: secrets)
        check("saving again without retyping a secret keeps it", again == saved && secrets.get(item) == "sk_live_selftest_abc")
        _ = WorkspaceEnv.save(reopened.filter { $0.key != "STRIPE_KEY" }, workspace: "w1", old: saved, secrets: secrets)
        check("removing a secret variable deletes its Keychain item", secrets.get(item) == nil)
        check(
            "a key with a space, a dash or Forge's own prefix is refused, letters, digits and _ are fine",
            !WorkspaceEnv.validKey("MY KEY") && !WorkspaceEnv.validKey("my-key") && !WorkspaceEnv.validKey("1ABC")
                && !WorkspaceEnv.validKey("FORGE_HOME") && WorkspaceEnv.validKey("MY_KEY_2"))
        let old = #"{"id":"w","name":"Old"}"#
        let decoded = try? JSONDecoder().decode(Workspace.self, from: Data(old.utf8))
        check("a workspace saved before workspace setup existed still loads", decoded?.name == "Old" && decoded?.setup == nil)
        check(
            "card agents get the workspace's variables, and Forge's own variables win",
            EngineSettings.withWorkspaceEnv(["GH_TOKEN": "forge"], ["GH_TOKEN": "mine", "RAILS_ENV": "dev"]) == [
                "GH_TOKEN": "forge", "RAILS_ENV": "dev",
            ])
    }

    static func setupPayloadChecks(_ check: (String, Bool) -> Void) {
        let secrets = MemorySecrets()
        let env = WorkspaceEnv.save([EnvRow(key: "STRIPE_KEY", value: "sk_x", secret: true)], workspace: "w1", old: [], secrets: secrets)
        let setup = WorkspaceSetup(copy: ["config/master.key", "storage/"], setupScript: "bin/setup", cleanupScript: "bin/clean", env: env)
        let p = setup.payload(workspace: "w1", secrets: secrets)
        check(
            "the sessions host gets the copy list, both scripts, the values and which ones are secret",
            (p["copy"] as? [String]) == ["config/master.key", "storage/"] && (p["setup"] as? String) == "bin/setup"
                && (p["cleanup"] as? String) == "bin/clean" && (p["secrets"] as? [String]) == ["STRIPE_KEY"]
                && (p["env"] as? [String: String]) == ["STRIPE_KEY": "sk_x"])
        check(
            "the repo picker lists what git ignores, sorted, folders ending in /",
            WorkspaceSetupReader.parseIgnored(".env\nnode_modules/\nconfig/master.key\n\n") == [".env", "config/master.key", "node_modules/"])
        check(
            "the Settings tile sums the setup up in plain words",
            WorkspaceSetup.summary(setup).env == "1 variable, 1 secret" && WorkspaceSetup.summary(WorkspaceSetup()).env == "None")
    }

    static func agentNoticeChecks(_ check: (String, Bool) -> Void) {
        let m = SessionsModel(preview: true)
        guard let s = m.sessions.first, let base = s.chats.first else { return check("the sample sessions load", false) }
        var working = base
        working.state = "working"
        var done = base
        done.state = "idle"
        var waiting = base
        waiting.state = "needs_you"
        var failed = base
        failed.state = "failed"
        check(
            "an agent that finishes posts \"is done\"",
            AgentNotice.decide(old: working, new: done, session: s, looking: false, on: true)?.title == "\(s.title) is done")
        check(
            "an agent waiting on you posts \"needs you\"",
            AgentNotice.decide(old: working, new: waiting, session: s, looking: false, on: true)?.title == "\(s.title) needs you")
        check(
            "an agent that fails posts \"stopped\"",
            AgentNotice.decide(old: working, new: failed, session: s, looking: false, on: true)?.title == "\(s.title) stopped")
        check("nothing for the session you're looking at", AgentNotice.decide(old: working, new: done, session: s, looking: true, on: true) == nil)
        check("nothing when Agent notifications is off", AgentNotice.decide(old: working, new: done, session: s, looking: false, on: false) == nil)
        check("nothing when the chat wasn't working", AgentNotice.decide(old: done, new: done, session: s, looking: false, on: true) == nil)
        check("Agent notifications is on by default", SetupStore().agentNotificationsOn)
        check(
            "a notice opens its own session when clicked",
            AgentNotice.decide(old: working, new: done, session: s, looking: false, on: true)?.session == s.id)

        // Through the model, as a live chat frame arrives: one chime and one notification, the chime only once.
        var posted: [AgentNotice] = []
        var chimes = 0
        let n = AgentNotifier.shared
        let saved = (n.sink, n.chime, n.enabled, n.front)
        defer { (n.sink, n.chime, n.enabled, n.front) = saved }
        n.sink = { posted.append($0) }
        n.chime = { chimes += 1 }
        n.enabled = { true }
        n.front = { true }
        if let i = m.sessions.firstIndex(where: { $0.id == s.id }) { m.sessions[i].chats[0] = working }
        let other = m.sessions.first { $0.id != s.id }
        m.selected = other?.id
        m.apply(.chat(done))
        check("a chat in another session that finishes fires one notification", posted.count == 1 && posted.first?.session == s.id)
        check(
            "with one chime, not two sounds",
            chimes == 1 && AgentNotifier.content(for: posted.first ?? AgentNotice(title: "", body: "", session: "")).sound == nil)
        if let i = m.sessions.firstIndex(where: { $0.id == s.id }) { m.sessions[i].chats[0] = working }
        m.selected = s.id
        m.apply(.chat(done))
        check("the session on screen, with Forge in front, fires nothing", posted.count == 1 && chimes == 1)
        if let i = m.sessions.firstIndex(where: { $0.id == s.id }) { m.sessions[i].chats[0] = working }
        n.enabled = { false }
        m.selected = other?.id
        m.apply(.chat(done))
        check("switched off, nothing fires", posted.count == 1 && chimes == 1)
    }
}
