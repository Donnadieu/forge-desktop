import Foundation

/// Workspace setup (Omar, Nov 12 2026; docs/design/workspace-settings.md): what every new session of a workspace
/// gets before its agent starts, and what runs when it's archived. Kept in `store.json` with the workspace, except
/// secret values, which live only in the Keychain (`WorkspaceEnv.item`). Paths are relative to each repo's top folder.
struct WorkspaceSetup: Codable, Equatable, Sendable {
    /// Files and folders git ignores, copied from the person's checkout into each new session's folder (`dir/`).
    var copy: [String]?
    /// Runs in the new session's folder when it starts; its output shows in the session.
    var setupScript: String?
    /// Runs in the session's folder when it's archived, before the folder goes.
    var cleanupScript: String?
    /// Given to every agent, script and terminal of the workspace. Secrets keep only their key here.
    var env: [EnvVar]?

    var isEmpty: Bool {
        (copy ?? []).isEmpty && (setupScript ?? "").isBlank && (cleanupScript ?? "").isBlank && (env ?? []).isEmpty
    }

    /// What the sessions host is told (in memory only): the list, the scripts, every value and which are secret.
    func payload(workspace: String, secrets: SecretStore) -> [String: Any] {
        let vars = env ?? []
        return [
            "copy": copy ?? [], "setup": setupScript ?? "", "cleanup": cleanupScript ?? "",
            "env": WorkspaceEnv.values(vars, workspace: workspace, secrets: secrets),
            "secrets": vars.filter { $0.secret == true }.map(\.key),
        ]
    }

    /// The Settings tile's lines.
    struct Summary: Equatable {
        var files: String
        var setup: String
        var cleanup: String
        var env: String
    }

    static func summary(_ s: WorkspaceSetup) -> Summary {
        let files = s.copy ?? []
        let vars = s.env ?? []
        let secret = vars.filter { $0.secret == true }.count
        func script(_ t: String?) -> String {
            guard let line = t?.split(separator: "\n").first.map(String.init), !line.isBlank else { return "None" }
            return line.count > 34 ? String(line.prefix(33)) + "…" : line
        }
        var env = vars.isEmpty ? "None" : "\(vars.count) variable" + (vars.count == 1 ? "" : "s")
        if secret > 0 { env += ", \(secret) secret" + (secret == 1 ? "" : "s") }
        return Summary(
            files: files.isEmpty ? ".env files only" : ([".env"] + files).joined(separator: ", "),
            setup: script(s.setupScript), cleanup: script(s.cleanupScript), env: env)
    }
}

/// One variable. A secret keeps no value here: it's in the Keychain.
struct EnvVar: Codable, Equatable, Sendable {
    var key: String
    var value: String?
    var secret: Bool?
}

/// A row of the Environment editor. A saved secret comes back with an empty value and `kept`; typing replaces it.
struct EnvRow: Equatable, Identifiable {
    var id = UUID()
    var key: String
    var value: String
    var secret: Bool
    /// A secret already in the Keychain, not retyped.
    var kept = false

    /// What the row shows: a kept secret as dots, anything else as typed.
    var shown: String { kept && value.isEmpty ? WorkspaceEnv.mask : value }

    static func rows(_ vars: [EnvVar]) -> [EnvRow] {
        vars.map { v in
            v.secret == true ? EnvRow(key: v.key, value: "", secret: true, kept: true) : EnvRow(key: v.key, value: v.value ?? "", secret: false)
        }
    }
}

/// Where secrets go: the Keychain for the person, memory for checks.
protocol SecretStore {
    func get(_ name: String) -> String?
    func set(_ value: String, _ name: String)
    func delete(_ name: String)
}

struct KeychainSecrets: SecretStore {
    func get(_ name: String) -> String? { Keychain.get(named: name) }
    func set(_ value: String, _ name: String) { Keychain.set(value, named: name) }
    func delete(_ name: String) { Keychain.delete(named: name) }
}

final class MemorySecrets: SecretStore {
    private var items: [String: String] = [:]
    func get(_ name: String) -> String? { items[name] }
    func set(_ value: String, _ name: String) { items[name] = value }
    func delete(_ name: String) { items[name] = nil }
}

enum WorkspaceEnv {
    static let mask = "••••••••"

    /// A secret's Keychain item: one per workspace and key.
    static func item(workspace: String, key: String) -> String { "workspace-env.\(workspace).\(key)" }

    /// Letters, digits and _, not starting with a digit (what a shell takes), and not one of Forge's own `FORGE_`.
    static func validKey(_ k: String) -> Bool {
        k.range(of: #"^[A-Za-z_][A-Za-z0-9_]*$"#, options: .regularExpression) != nil && !k.uppercased().hasPrefix("FORGE_")
    }

    /// The editor's rows as saved: plain values in the record, secrets into the store (a kept secret stays as it
    /// was), and the items of secrets that went away (or became plain) deleted. Rows with a bad or repeated key drop.
    static func save(_ rows: [EnvRow], workspace: String, old: [EnvVar], secrets: SecretStore) -> [EnvVar] {
        var out: [EnvVar] = []
        var seen = Set<String>()
        for r in rows {
            let key = r.key.trimmingCharacters(in: .whitespaces)
            guard validKey(key), !seen.contains(key) else { continue }
            seen.insert(key)
            if r.secret {
                if !r.value.isEmpty { secrets.set(r.value, item(workspace: workspace, key: key)) }
                guard !r.value.isEmpty || r.kept else { continue }
                out.append(EnvVar(key: key, value: nil, secret: true))
            } else {
                out.append(EnvVar(key: key, value: r.value, secret: nil))
            }
        }
        let keptSecrets = Set(out.filter { $0.secret == true }.map(\.key))
        for v in old where v.secret == true && !keptSecrets.contains(v.key) {
            secrets.delete(item(workspace: workspace, key: v.key))
        }
        return out
    }

    /// Every variable with its value, secrets read back from the store (a missing one is left out).
    static func values(_ vars: [EnvVar], workspace: String, secrets: SecretStore) -> [String: String] {
        var env: [String: String] = [:]
        for v in vars {
            if v.secret == true {
                if let s = secrets.get(item(workspace: workspace, key: v.key)) { env[v.key] = s }
            } else {
                env[v.key] = v.value ?? ""
            }
        }
        return env
    }

    /// A deleted workspace's secrets go with it.
    static func forget(_ vars: [EnvVar], workspace: String, secrets: SecretStore) {
        for v in vars where v.secret == true { secrets.delete(item(workspace: workspace, key: v.key)) }
    }
}

extension SetupStore {
    /// Agent notifications (one switch on this Mac; nil = on).
    var agentNotificationsOn: Bool { agentNotifications ?? true }
}

extension String {
    var isBlank: Bool { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}
