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
