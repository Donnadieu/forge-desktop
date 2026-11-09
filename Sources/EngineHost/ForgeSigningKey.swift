import Foundation

/// The signing key Forge makes (setup screen 3, first choice): an SSH key whose private half lives only in
/// the Keychain. Before the engine starts, Forge hands it to the Mac's ssh-agent; git signs through the
/// agent with only the public half on disk. Registering it on GitHub changes the person's account, so the
/// app asks first.
enum ForgeSigningKey {
    static var publicKeyURL: URL { Paths.home.appendingPathComponent("signing/forge_signing.pub") }

    static var exists: Bool {
        FileManager.default.fileExists(atPath: publicKeyURL.path) && Keychain.get(.signingKey) != nil
    }

    static var publicKey: String? {
        (try? String(contentsOf: publicKeyURL, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Makes a new ed25519 key: private half into the Keychain, public half next to Forge's settings.
    static func make(comment: String) async -> Bool {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("forge-key-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: tmp) }
        let file = tmp.appendingPathComponent("k")
        let r = await Tools.run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", file.path], timeout: 20)
        guard r.ok, let priv = try? String(contentsOf: file, encoding: .utf8),
            let pub = try? String(contentsOf: file.appendingPathExtension("pub"), encoding: .utf8)
        else { return false }
        guard Keychain.set(priv, for: .signingKey) else { return false }
        try? FileManager.default.createDirectory(at: publicKeyURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        return (try? pub.write(to: publicKeyURL, atomically: true, encoding: .utf8)) != nil
    }

    /// Hands the private half to the Mac's ssh-agent (read from stdin; never written to disk).
    static func loadIntoAgent() async -> Bool {
        guard let priv = Keychain.get(.signingKey) else { return false }
        return await Tools.run("ssh-add", ["-q", "-"], input: priv, timeout: 15).ok
    }

    /// Is the public half already one of the person's GitHub signing keys?
    static func registered() async -> Bool {
        guard let pub = publicKey else { return false }
        let body = pub.split(separator: " ").prefix(2).joined(separator: " ")
        let r = await GitHub.gh(["api", "user/ssh_signing_keys", "--jq", ".[].key"], timeout: 20)
        return r.ok && r.out.contains(body)
    }

    enum Registration: Equatable {
        case done
        case needsPermission
        case failed(String)
    }

    /// The key's name on GitHub, which anyone can read (`/users/<login>/ssh_signing_keys`): plain, never the app's.
    static let title = "Commit signing"

    /// Adds the public half to the person's GitHub as a signing key. Only after they said yes in the app.
    static func register(title: String) async -> Registration {
        guard let pub = publicKey else { return .failed("there's no key yet") }
        let r = await GitHub.gh(["api", "-X", "POST", "user/ssh_signing_keys", "-f", "title=\(title)", "-f", "key=\(pub)"], timeout: 20)
        if r.ok { return .done }
        if r.err.contains("admin:ssh_signing_key") || r.err.contains("HTTP 404") || r.err.contains("HTTP 403") { return .needsPermission }
        return .failed(r.err.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}
