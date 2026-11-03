import AppKit
import Foundation

/// Finds a newer Forge in the repo's GitHub releases (through the person's `gh` sign-in, since the repo
/// may be private), downloads `Forge.zip`, checks its signature, and swaps it in after Forge quits.
@MainActor
final class Updater: ObservableObject {
    static let shared = Updater()

    struct Release: Equatable, Sendable {
        let tag: String
        let version: String
        let notes: String
    }

    @Published private(set) var available: Release?
    @Published private(set) var problem: String?
    @Published private(set) var installing = false
    private var timer: Timer?

    static var repo: String? { Bundle.main.object(forInfoDictionaryKey: "ForgeUpdateRepo") as? String }
    static var current: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0" }

    /// "1.2.10" > "1.2.9".
    static func newer(_ a: String, than b: String) -> Bool {
        let x = a.split(separator: ".").map { Int($0) ?? 0 }
        let y = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(x.count, y.count) {
            let l = i < x.count ? x[i] : 0
            let r = i < y.count ? y[i] : 0
            if l != r { return l > r }
        }
        return false
    }

    func startChecking() {
        guard Self.repo?.isEmpty == false else { return }
        Task { await check() }
        timer = Timer.scheduledTimer(withTimeInterval: 6 * 60 * 60, repeats: true) { _ in Task { @MainActor in await Updater.shared.check() } }
    }

    /// Newest non-draft release with a Forge.zip that's newer than this copy.
    func check() async {
        guard let repo = Self.repo, !repo.isEmpty else { return }
        let jq = "[.[] | select(.draft|not) | select(any(.assets[]; .name == \"Forge.zip\")) | [.tag_name, (.body // \"\")]] | .[] | @json"
        let r = await GitHub.gh(["api", "repos/\(repo)/releases?per_page=20", "--jq", jq], timeout: 30)
        guard r.ok else { return }
        var best: Release?
        for line in r.out.split(separator: "\n") {
            guard let arr = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String], arr.count == 2 else { continue }
            let version = arr[0].hasPrefix("v") ? String(arr[0].dropFirst()) : arr[0]
            if Self.newer(version, than: best?.version ?? Self.current) { best = Release(tag: arr[0], version: version, notes: arr[1]) }
        }
        available = best
    }

    /// Downloads, checks and stages the update, then quits; a small script swaps the app and reopens it.
    func install() async {
        guard let rel = available, let repo = Self.repo, !installing else { return }
        installing = true
        problem = nil
        defer { installing = false }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("forge-update-\(rel.version)")
        try? FileManager.default.removeItem(at: dir)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dl = await GitHub.gh(["release", "download", rel.tag, "-R", repo, "-p", "Forge.zip", "-D", dir.path], timeout: 600)
        guard dl.ok else { return fail("Forge couldn't download the update.") }
        let unzip = await Tools.run("ditto", ["-x", "-k", dir.appendingPathComponent("Forge.zip").path, dir.path], timeout: 120)
        let newApp = dir.appendingPathComponent("Forge.app")
        guard unzip.ok, FileManager.default.fileExists(atPath: newApp.path) else { return fail("The update didn't unpack.") }
        // Same signer as this copy, and Gatekeeper accepts it.
        let verify = await Tools.run("codesign", ["--verify", "--deep", "--strict", newApp.path], timeout: 120)
        let gate = await Tools.run("spctl", ["-a", "-t", "exec", newApp.path], timeout: 120)
        guard verify.ok, gate.ok || Self.adhocSelf else { return fail("The update's signature didn't check out, so Forge didn't install it.") }
        let target = Bundle.main.bundleURL.path
        let script = dir.appendingPathComponent("swap.sh")
        let reopen = ProcessInfo.processInfo.environment["FORGE_UPDATE_NO_REOPEN"] == "1" ? "" : "open \"\(target)\""
        let text = """
            #!/bin/bash
            while kill -0 \(ProcessInfo.processInfo.processIdentifier) 2>/dev/null; do sleep 0.5; done
            rm -rf "\(target).old" && mv "\(target)" "\(target).old" && ditto "\(newApp.path)" "\(target)" && rm -rf "\(target).old"
            \(reopen)
            """
        guard (try? text.write(to: script, atomically: true, encoding: .utf8)) != nil else { return fail("Forge couldn't stage the update.") }
        Tools.launchDetached("/bin/bash", [script.path])
        staged = rel.version
        // From the command line (`--update-now`) there is no running app: the swap waits for this process to exit.
        if let app = NSApp, app.isRunning { app.terminate(nil) }
    }

    /// The version staged by the last `install()`; the swap happens once this process exits.
    private(set) var staged: String?

    /// A local, ad hoc-signed copy can't pass Gatekeeper; it may still update itself for testing.
    private static var adhocSelf: Bool { ProcessInfo.processInfo.environment["FORGE_UPDATE_ALLOW_ADHOC"] == "1" }

    private func fail(_ why: String) {
        problem = why
    }
}
