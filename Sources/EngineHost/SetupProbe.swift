import Foundation

/// `Forge --github-check [owner/repo]`: what setup screens 3 and 4 would see on this Mac, read-only.
/// Prints who `gh` is signed in as, how many repos it lists, push rights on one repo, and the GPG keys that sign.
enum SetupProbe {
    static func github(repo: String?) -> Int32 {
        let done = DispatchSemaphore(value: 0)
        let box = Box()
        Task.detached {
            box.code = await run(repo: repo)
            done.signal()
        }
        done.wait()
        return box.code
    }

    private final class Box: @unchecked Sendable { var code: Int32 = 1 }

    /// `Forge --update-now`: finds, downloads, checks and stages the newest release; swaps it in on exit.
    static func updateNow() -> Int32 {
        let done = DispatchSemaphore(value: 0)
        let box = Box()
        Task { @MainActor in
            GitHub.account = SetupChoices.load().githubLogin ?? ProcessInfo.processInfo.environment["FORGE_GITHUB_ACCOUNT"]
            await Updater.shared.check()
            if let rel = Updater.shared.available {
                await Updater.shared.install()
                if let staged = Updater.shared.staged {
                    print("✓ staged \(staged); it replaces this copy once Forge exits")
                    box.code = 0
                } else {
                    print("✗ \(Updater.shared.problem ?? "the update didn't install") (\(rel.version))")
                }
            } else {
                print("· up to date (\(Updater.current))")
                box.code = 0
            }
            done.signal()
        }
        while done.wait(timeout: .now()) == .timedOut { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        return box.code
    }

    /// `Forge --check-update`: this copy's version, the repo it updates from, and the newest release there.
    static func checkUpdate() -> Int32 {
        let done = DispatchSemaphore(value: 0)
        Task { @MainActor in
            GitHub.account = SetupChoices.load().githubLogin ?? ProcessInfo.processInfo.environment["FORGE_GITHUB_ACCOUNT"]
            await Updater.shared.check()
            let found = Updater.shared.available.map { "update available: \($0.version)" } ?? "up to date"
            print("Forge \(Updater.current) · releases from \(Updater.repo ?? "nowhere") · \(found)")
            done.signal()
        }
        while done.wait(timeout: .now()) == .timedOut { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        return 0
    }

    /// `Forge --worker-check <claude|codex|kimi|apiKey> [model]`: setup 5's real call, from the command line.
    static func worker(_ name: String, model: String?) -> Int32 {
        guard let w = SetupChoices.Worker(rawValue: name) else {
            print("✗ unknown worker \(name); use claude, codex, kimi or apiKey")
            return 2
        }
        let done = DispatchSemaphore(value: 0)
        let box = Box()
        Task.detached {
            let key: String? =
                switch w {
                case .apiKey: Keychain.get(.anthropicKey)
                case .kimi: Keychain.get(.kimiKey)
                case .claude, .codex: nil
                }
            switch await WorkerCheck.run(w, model: model, key: key) {
            case .works:
                print("✓ \(name) answered a real call")
                box.code = 0
            case .fails(let why):
                print("✗ \(why)")
            }
            done.signal()
        }
        done.wait()
        return box.code
    }

    private static func run(repo: String?) async -> Int32 {
        let accounts = await GitHub.accounts()
        print("· gh accounts on this Mac: \(accounts.joined(separator: ", "))")
        GitHub.account = ProcessInfo.processInfo.environment["FORGE_GITHUB_ACCOUNT"] ?? accounts.first
        guard let user = await GitHub.user() else {
            print("✗ gh isn't signed in on this Mac")
            return 1
        }
        print("✓ signed in to GitHub as @\(user.login) (\(user.name)); commits would use \(user.noreplyEmail)")
        let repos = await GitHub.repos()
        print("\(repos.isEmpty ? "✗" : "✓") \(repos.count) repos listed; \(repos.filter(\.canPush).count) you can push to")
        if let repo {
            print("\(await GitHub.canPush(repo) ? "✓" : "✗") push rights on \(repo)")
        }
        let keys = await GitHub.gpgKeys()
        print("✓ \(keys.count) GPG keys can sign: \(keys.map { "\($0.name) <\($0.email)>" }.joined(separator: ", "))")
        if let id = ProcessInfo.processInfo.environment["FORGE_PROBE_GPG_KEY"], let k = keys.first(where: { $0.id == id }) {
            let ok = await GitHub.signs(name: k.name, email: k.email, signing: .ownGPG, key: k.id)
            print("\(ok ? "✓" : "✗") a test commit signed with that GPG key")
        }
        print("\(ForgeSigningKey.exists ? "✓" : "·") Forge's own signing key \(ForgeSigningKey.exists ? "exists" : "isn't made yet")")
        return 0
    }
}
