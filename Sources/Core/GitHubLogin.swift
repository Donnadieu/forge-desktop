import Foundation

/// Signing in to GitHub for the board (GitHub Issues on a GitHub project): GitHub's device sign-in, the
/// person approves a short code on github.com. Forge asks for `repo`, `read:org` and `project`, the last of
/// which the Mac's own `gh` sign-in usually lacks. The token lives only in the Keychain
/// (`github-tracker-login`); GitHub's tokens from this sign-in don't run out, so there is nothing to renew.
/// The engine and the agents' tool get it from `Forge --github-token`. By default Forge signs in as GitHub's
/// own command-line tool does (its public client, so the page says "GitHub CLI"); `FORGE_GITHUB_CLIENT_ID`
/// names another OAuth app, and `FORGE_GITHUB_AUTH` points checks at a stand-in sign-in server.
enum GitHubLogin {
    static var clientID: String { ProcessInfo.processInfo.environment["FORGE_GITHUB_CLIENT_ID"] ?? "178c6fc778ccc68e1d6a" }
    static var authBase: String { ProcessInfo.processInfo.environment["FORGE_GITHUB_AUTH"] ?? "https://github.com" }
    static let scopes = "repo read:org project"

    typealias Failure = BasecampLogin.Failure

    /// What's kept in the Keychain.
    struct Tokens: Codable, Equatable, Sendable {
        var accessToken: String
        var scope: String?

        enum CodingKeys: String, CodingKey {
            case accessToken = "access_token"
            case scope
        }

        /// GitHub granted the permission to move cards on projects.
        var canUseProjects: Bool { (scope ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.contains("project") }
    }

    struct DeviceCode: Sendable {
        let deviceCode: String
        let userCode: String
        let verificationURL: String
        let interval: Double
        let expiresAt: Date
    }

    static func start() async throws -> DeviceCode {
        let obj = try await post("/login/device/code", ["client_id": clientID, "scope": scopes])
        guard let device = obj["device_code"] as? String, let user = obj["user_code"] as? String else {
            throw Failure(description: "GitHub didn't start the sign-in.")
        }
        let link = obj["verification_uri"] as? String ?? "\(authBase)/login/device"
        let expires = (obj["expires_in"] as? Double) ?? Double(obj["expires_in"] as? Int ?? 900)
        let interval = (obj["interval"] as? Double) ?? Double(obj["interval"] as? Int ?? 5)
        return DeviceCode(
            deviceCode: device, userCode: user, verificationURL: link, interval: interval, expiresAt: Date().addingTimeInterval(expires))
    }

    /// Waits until the person approves the code, then keeps the sign-in. Throws if they deny it or it expires.
    static func finish(_ code: DeviceCode) async throws -> Tokens {
        var wait = max(1, code.interval)
        while Date() < code.expiresAt {
            try await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            let obj = try await post(
                "/login/oauth/access_token",
                ["client_id": clientID, "device_code": code.deviceCode, "grant_type": "urn:ietf:params:oauth:grant-type:device_code"])
            switch obj["error"] as? String {
            case nil:
                guard let access = obj["access_token"] as? String else { throw Failure(description: "GitHub sent no token.") }
                let tokens = Tokens(accessToken: access, scope: obj["scope"] as? String)
                guard save(tokens) else { throw Failure(description: "Forge couldn't keep the sign-in in your Keychain.") }
                return tokens
            case "authorization_pending": continue
            case "slow_down": wait = (obj["interval"] as? Double) ?? Double(obj["interval"] as? Int ?? Int(wait + 5))
            case "access_denied": throw Failure(description: "The sign-in was turned down on GitHub.", signedOut: true)
            case "expired_token": throw Failure(description: "The code ran out. Start the sign-in again.", signedOut: true)
            case let other?: throw Failure(description: "GitHub said: \(other)")
            }
        }
        throw Failure(description: "The code ran out. Start the sign-in again.", signedOut: true)
    }

    static func load() -> Tokens? {
        guard let s = Keychain.get(.githubTrackerLogin) else { return nil }
        return try? JSONDecoder().decode(Tokens.self, from: Data(s.utf8))
    }

    @discardableResult
    static func save(_ t: Tokens) -> Bool {
        guard let d = try? JSONEncoder().encode(t), let s = String(data: d, encoding: .utf8) else { return false }
        return Keychain.set(s, for: .githubTrackerLogin)
    }

    static func signOut() { Keychain.delete(.githubTrackerLogin) }

    static func accessToken() throws -> String {
        guard let t = load() else { throw Failure(description: "Forge isn't signed in to GitHub for the board.", signedOut: true) }
        return t.accessToken
    }

    /// `Forge --github-token`: one JSON line for the engine and the agents' tool. Never logs the token. The
    /// hour is only how long they keep it in memory before asking again.
    static func printToken() -> Int32 {
        guard let t = load() else {
            FileHandle.standardError.write(Data("GitHub sign-in needed: Forge isn't signed in to GitHub for the board.\n".utf8))
            return 3
        }
        let line =
            (try? JSONSerialization.data(withJSONObject: ["access_token": t.accessToken, "expires_at": Int(Date().timeIntervalSince1970) + 3600]))
            ?? Data()
        FileHandle.standardOutput.write(line + Data("\n".utf8))
        return 0
    }

    private static func post(_ path: String, _ form: [String: String]) async throws -> [String: Any] {
        guard let url = URL(string: authBase + path) else { throw Failure(description: "Bad sign-in address.") }
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.timeoutInterval = 20
        r.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        r.httpBody = Data(
            form.sorted { $0.key < $1.key }
                .map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? $0.value)" }
                .joined(separator: "&").utf8)
        let (data, response) = try await URLSession.shared.data(for: r)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if (200..<300).contains(code) || obj["error"] != nil { return obj }
        if code == 429 { throw Failure(description: "GitHub asked Forge to slow down. Try again in a minute.") }
        throw Failure(description: "GitHub answered \(code).")
    }
}
