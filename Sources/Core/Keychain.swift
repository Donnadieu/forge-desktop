import Foundation
import Security

/// Secrets live here and nowhere else: the Linear key, AI keys, the signing key Forge makes.
/// One generic-password item per secret under Forge's own service name.
enum Keychain {
    static let service = "ai.forjado.forge"

    /// The names Forge stores secrets under. Never the secret itself.
    enum Item: String, CaseIterable {
        case linearKey = "linear-key"
        case anthropicKey = "anthropic-key"
        case kimiKey = "kimi-key"
        case claudeToken = "claude-code-token"
        case signingKey = "signing-key"
    }

    /// `FORGE_KEYCHAIN_SERVICE` gives checks their own service so they never touch the person's items.
    private static var serviceName: String {
        ProcessInfo.processInfo.environment["FORGE_KEYCHAIN_SERVICE"] ?? service
    }

    private static func query(_ item: Item) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: serviceName, kSecAttrAccount as String: item.rawValue]
    }

    @discardableResult
    static func set(_ value: String, for item: Item) -> Bool {
        let data = Data(value.utf8)
        let update = SecItemUpdate(query(item) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return true }
        var add = query(item)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    static func get(_ item: Item) -> String? {
        var q = query(item)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func delete(_ item: Item) -> Bool {
        let s = SecItemDelete(query(item) as CFDictionary)
        return s == errSecSuccess || s == errSecItemNotFound
    }
}
