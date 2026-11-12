import Foundation

/// Sample workspace setup, terminal and long paste for `--render-screens` (never the Keychain or a real shell).
@MainActor
enum SampleSetup {
    static let setup = WorkspaceSetup(
        copy: ["config/master.key", "storage/dev-seeds/"], setupScript: "bundle install && yarn install && bin/rails db:prepare",
        cleanupScript: "bin/rails db:drop",
        env: [
            EnvVar(key: "RAILS_ENV", value: "development", secret: nil), EnvVar(key: "STRIPE_SECRET_KEY", value: nil, secret: true),
            EnvVar(key: "REDIS_URL", value: "redis://localhost:6379/2", secret: nil),
        ])

    static let shell =
        "\u{1B}[32m~/forge/folders/acme-app/fix-login\u{1B}[0m % bin/rails test test/models/user_test.rb\r\n"
        + "Running 14 tests in a single process\r\nRun options: --seed 48211\r\n\r\n# Running:\r\n\r\n"
        + "\u{1B}[32m..............\u{1B}[0m\r\n\r\nFinished in 0.912s, 15.35 runs/s, 41.66 assertions/s.\r\n"
        + "14 runs, 38 assertions, \u{1B}[32m0 failures\u{1B}[0m, 0 errors, 0 skips\r\n"
        + "\u{1B}[32m~/forge/folders/acme-app/fix-login\u{1B}[0m % git status --short\r\n \u{1B}[31mM\u{1B}[0m app/models/user.rb\r\n"
        + " \u{1B}[31mM\u{1B}[0m test/models/user_test.rb\r\n\u{1B}[32m~/forge/folders/acme-app/fix-login\u{1B}[0m % "

    static func scene(_ m: AppModel, _ scene: String?) {
        guard let scene else { return }
        if scene == "workspace-setup", let i = m.store.workspaces?.firstIndex(where: { $0.id == m.workspace?.id }) {
            m.store.workspaces?[i].setup = setup
        }
        let s = m.sessions
        guard scene.hasPrefix("sessions-"), let i = s.sessions.firstIndex(where: { $0.id == "s1" }) else { return }
        // s1 when the scene picked no session, or the scene is about s1; a session the scene picked stays (forcing s1 on
        // every scene drew s1's chat in 14-sessions-card).
        let own = ["sessions-terminal", "sessions-setup-failed", "sessions-setup-running", "sessions-long-paste"]
        if s.current == nil || own.contains(scene) { s.selected = "s1" }
        switch scene {
        case "sessions-terminal":
            s.sessions[i].folder = "~/forge/folders/acme-app/fix-login"
            let tabs = [
                TerminalTab(sample: "Terminal 1", output: shell, cols: 110, rows: 14),
                TerminalTab(sample: "Terminal 2", output: "% ", cols: 110, rows: 14),
            ]
            Terminals.shared.sample(tabs, on: s.sessions[i].id)
        case "sessions-setup-failed":
            s.sessions[i].setup = Sessions.ScriptRun(
                state: "failed", exitCode: 1,
                output:
                    "bundle install\nFetching gem metadata from https://rubygems.org/.........\nCould not find gem 'pg (~> 1.5)' in locally installed gems.\nRun `bundle install` to install missing gems.",
                startedAt: nil, endedAt: nil)
        case "sessions-setup-running":
            s.sessions[i].setup = Sessions.ScriptRun(
                state: "running", exitCode: nil, output: "bundle install\nFetching gem metadata from https://rubygems.org/...", startedAt: nil,
                endedAt: nil)
        case "sessions-long-paste":
            if let c = s.sessions[i].chats.first {
                s.drafts[c.id] = "Here's the CI log. Find why the job failed."
                s.attachText(String(repeating: "2026-11-12T10:42:07Z  bundle exec rspec spec/models/user_spec.rb\n", count: 80), to: c)
            }
        default: break
        }
    }
}
