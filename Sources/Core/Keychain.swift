import Foundation
import Security

/// Secrets live here and nowhere else: the Linear key, the Basecamp and GitHub board sign-ins, AI keys, the signing key Forge makes.
/// One generic-password item per secret under Forge's own service name.
enum Keychain {
    static let service = "ai.forjado.forge"

    /// The names Forge stores secrets under. Never the secret itself.
    enum Item: String, CaseIterable {
        case linearKey = "linear-key"
        case anthropicKey = "anthropic-key"
        case kimiKey = "kimi-key"
        case openaiKey = "openai-key"
        case claudeToken = "claude-code-token"
        case signingKey = "signing-key"
        /// The Basecamp sign-in (access and refresh tokens, as JSON). Only `BasecampLogin` reads it.
        case basecampLogin = "basecamp-login"
        /// The GitHub sign-in for a GitHub Issues board (token and scopes, as JSON). Only `GitHubLogin` reads it.
        case githubTrackerLogin = "github-tracker-login"
    }

    /// `FORGE_KEYCHAIN_SERVICE` gives checks their own service so they never touch the person's items.
    private static var serviceName: String {
        ProcessInfo.processInfo.environment["FORGE_KEYCHAIN_SERVICE"] ?? service
    }

    /// `FORGE_KEYCHAIN_PATH` puts checks' items in a keychain file of their own (unlocked by the check), for
    /// shells that may not write the login keychain. Unset for the person: their login keychain.
    private static var testKeychain: SecKeychain? {
        guard let path = ProcessInfo.processInfo.environment["FORGE_KEYCHAIN_PATH"], !path.isEmpty else { return nil }
        var kc: SecKeychain?
        return SecKeychainOpen(path, &kc) == errSecSuccess ? kc : nil
    }

    private static func query(_ name: String, adding: Bool = false) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: serviceName, kSecAttrAccount as String: name,
        ]
        if let kc = testKeychain {
            if adding { q[kSecUseKeychain as String] = kc } else { q[kSecMatchSearchList as String] = [kc] }
        }
        return q
    }

    @discardableResult
    static func set(_ value: String, for item: Item) -> Bool { set(value, named: item.rawValue) }

    static func get(_ item: Item) -> String? { get(named: item.rawValue) }

    @discardableResult
    static func delete(_ item: Item) -> Bool { delete(named: item.rawValue) }

    /// The same, for an item named at run time: each intelligence provider account keeps its sign-in or key
    /// under its own name (`AIAccount.secretItem`).
    @discardableResult
    static func set(_ value: String, named name: String) -> Bool {
        let data = Data(value.utf8)
        let update = SecItemUpdate(query(name) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return true }
        var add = query(name, adding: true)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    static func get(named name: String) -> String? {
        var q = query(name)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// True when the item is there. Reads only its attributes, never the secret, so it never asks the person.
    static func has(named name: String) -> Bool {
        var q = query(name)
        q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess
    }

    @discardableResult
    static func delete(named name: String) -> Bool {
        let s = SecItemDelete(query(name) as CFDictionary)
        return s == errSecSuccess || s == errSecItemNotFound
    }
}
