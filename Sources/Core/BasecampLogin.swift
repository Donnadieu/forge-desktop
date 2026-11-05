import Foundation

/// Signing in to Basecamp without a password box: Basecamp's device sign-in (the person approves a
/// short code in their browser), the way Basecamp's own command-line tool does it, with its public
/// client. The tokens live only in the Keychain (`basecamp-login`). The access token lasts about an
/// hour; `accessToken()` renews it from the refresh token, under a lock, so the app, the engine and the
/// agents' tool never renew at the same time (Basecamp may replace the refresh token on each renewal).
/// `FORGE_BASECAMP_AUTH` points checks at a stand-in sign-in server.
enum BasecampLogin {
    static let clientID = "basecamp-cli"
    static var authBase: String { ProcessInfo.processInfo.environment["FORGE_BASECAMP_AUTH"] ?? "https://app.basecamp.com" }

    struct Failure: Error, CustomStringConvertible {
        let description: String
        /// The sign-in is gone (refused or never made): only signing in again fixes it.
        var signedOut = false
    }

    /// What's kept in the Keychain.
    struct Tokens: Codable, Equatable, Sendable {
        var accessToken: String
        var refreshToken: String?
        /// Epoch seconds.
        var expiresAt: Double
        /// Basecamp's account binding (`urn:bc:account:<id>`), sent back on every renewal.
        var resource: String?

        enum CodingKeys: String, CodingKey {
            case accessToken = "access_token"
            case refreshToken = "refresh_token"
            case expiresAt = "expires_at"
            case resource
        }

        /// The account the sign-in is bound to, from `resource`.
        var accountID: String? {
            guard let r = resource, let id = r.split(separator: ":").last, id.allSatisfy(\.isNumber) else { return nil }
            return String(id)
        }
    }

    /// The code the person approves.
    struct DeviceCode: Sendable {
        let deviceCode: String
        let userCode: String
        let verificationURL: String
        let interval: Double
        let expiresAt: Date
    }

    // MARK: Device sign-in

    static func start() async throws -> DeviceCode {
        let obj = try await post("/oauth/device_authorizations", ["client_id": clientID, "scope": "full"])
        guard let device = obj["device_code"] as? String, let user = obj["user_code"] as? String else {
            throw Failure(description: "Basecamp didn't start the sign-in.")
        }
        let link = obj["verification_uri_complete"] as? String ?? obj["verification_uri"] as? String ?? "\(authBase)/oauth/device_verification"
        let expires = (obj["expires_in"] as? Double) ?? Double(obj["expires_in"] as? Int ?? 600)
        let interval = (obj["interval"] as? Double) ?? Double(obj["interval"] as? Int ?? 5)
        return DeviceCode(
            deviceCode: device, userCode: user, verificationURL: link, interval: interval, expiresAt: Date().addingTimeInterval(expires))
    }

    /// Waits until the person approves the code, then keeps the sign-in. Throws if they deny it or it expires.
    static func finish(_ code: DeviceCode, item: String? = nil) async throws -> Tokens {
        var wait = max(1, code.interval)
        while Date() < code.expiresAt {
            try await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            let obj = try await post(
                "/oauth/tokens",
                ["grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": code.deviceCode, "client_id": clientID],
                allowError: true)
            switch obj["error"] as? String {
            case nil:
                let tokens = try tokens(from: obj, keeping: nil)
                guard save(tokens, item: item) else { throw Failure(description: "Forge couldn't keep the sign-in in your Keychain.") }
                return tokens
            case "authorization_pending": continue
            case "slow_down": wait += 5
            case "access_denied": throw Failure(description: "The sign-in was turned down in Basecamp.", signedOut: true)
            case "expired_token": throw Failure(description: "The code ran out. Start the sign-in again.", signedOut: true)
            case let other?: throw Failure(description: "Basecamp said: \(other)")
            }
        }
        throw Failure(description: "The code ran out. Start the sign-in again.", signedOut: true)
    }

    // MARK: The kept sign-in

    /// The Keychain item of the connection Forge uses now (`--item` for the engine's command); each Basecamp
    /// connection keeps its own sign-in, so signing in to one never signs another out.
    nonisolated(unsafe) static var item = Keychain.Item.basecampLogin.rawValue

    static func load(item: String? = nil) -> Tokens? {
        guard let s = Keychain.get(named: item ?? Self.item) else { return nil }
        return try? JSONDecoder().decode(Tokens.self, from: Data(s.utf8))
    }

    @discardableResult
    static func save(_ t: Tokens, item: String? = nil) -> Bool {
        guard let d = try? JSONEncoder().encode(t), let s = String(data: d, encoding: .utf8) else { return false }
        return Keychain.set(s, named: item ?? Self.item)
    }

    static func signOut(item: String? = nil) { Keychain.delete(named: item ?? Self.item) }

    /// A token good for at least five more minutes, renewed if needed.
    static func accessToken(item: String? = nil) async throws -> Tokens {
        let item = item ?? Self.item
        return try await withLock {
            guard var t = load(item: item) else { throw Failure(description: "Forge isn't signed in to Basecamp.", signedOut: true) }
            if t.expiresAt - 300 > Date().timeIntervalSince1970 { return t }
            guard let refresh = t.refreshToken else { throw Failure(description: "The Basecamp sign-in ran out. Sign in again.", signedOut: true) }
            var form = ["grant_type": "refresh_token", "refresh_token": refresh, "client_id": clientID]
            if let r = t.resource { form["resource"] = r }
            let obj = try await post("/oauth/tokens", form, allowError: true)
            if let err = obj["error"] as? String {
                let gone = err == "invalid_grant" || err == "invalid_client" || err == "unauthorized_client"
                throw Failure(description: gone ? "Basecamp ended the sign-in. Sign in again." : "Basecamp said: \(err)", signedOut: gone)
            }
            t = try tokens(from: obj, keeping: t)
            guard save(t, item: item) else { throw Failure(description: "Forge couldn't keep the sign-in in your Keychain.") }
            return t
        }
    }

    /// `Forge --basecamp-token`: one JSON line for the engine and the agents' tool. Never logs the token.
    static func printToken() -> Int32 {
        let done = DispatchSemaphore(value: 0)
        final class Box: @unchecked Sendable { var code: Int32 = 1 }
        let box = Box()
        Task.detached {
            do {
                let t = try await accessToken()
                let line = try JSONSerialization.data(withJSONObject: ["access_token": t.accessToken, "expires_at": Int(t.expiresAt)])
                FileHandle.standardOutput.write(line + Data("\n".utf8))
                box.code = 0
            } catch let f as Failure {
                FileHandle.standardError.write(Data("\(f.description)\n".utf8))
                box.code = f.signedOut ? 3 : 1
            } catch {
                FileHandle.standardError.write(Data("Forge couldn't reach Basecamp: \(error.localizedDescription)\n".utf8))
            }
            done.signal()
        }
        done.wait()
        return box.code
    }

    // MARK: Plumbing

    static func tokens(from obj: [String: Any], keeping old: Tokens?) throws -> Tokens {
        guard let access = obj["access_token"] as? String else { throw Failure(description: "Basecamp sent no token.") }
        let expiresIn = (obj["expires_in"] as? Double) ?? Double(obj["expires_in"] as? Int ?? 3600)
        return Tokens(
            accessToken: access,
            refreshToken: obj["refresh_token"] as? String ?? old?.refreshToken,
            expiresAt: Date().timeIntervalSince1970 + expiresIn,
            resource: obj["resource"] as? String ?? old?.resource)
    }

    private static func post(_ path: String, _ form: [String: String], allowError: Bool = false) async throws -> [String: Any] {
        guard let url = URL(string: authBase + path) else { throw Failure(description: "Bad sign-in address.") }
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.timeoutInterval = 20
        r.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        r.httpBody = Data(
            form.sorted { $0.key < $1.key }
                .map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? $0.value)" }
                .joined(separator: "&").utf8)
        let (data, response) = try await URLSession.shared.data(for: r)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if (200..<300).contains(code) || (allowError && obj["error"] != nil) { return obj }
        if code == 429 { throw Failure(description: "Basecamp asked Forge to slow down. Try again in a minute.") }
        throw Failure(description: "Basecamp answered \(code).")
    }

    /// One renewal at a time across every Forge process (the app, the engine's command, the agents' tool).
    private static func withLock<T>(_ body: () async throws -> T) async throws -> T {
        try? FileManager.default.createDirectory(at: Paths.home, withIntermediateDirectories: true)
        let fd = open(Paths.home.appendingPathComponent(".basecamp-login.lock").path, O_CREAT | O_RDWR, 0o600)
        if fd >= 0 { flock(fd, LOCK_EX) }
        defer {
            if fd >= 0 {
                flock(fd, LOCK_UN)
                close(fd)
            }
        }
        return try await body()
    }
}
