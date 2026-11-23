import SwiftUI

/// GitHub's device sign-in for a GitHub Issues board: Forge asks GitHub for a code, opens github.com/login/device,
/// and waits. The person only types the code and approves; Forge then reads who they are and keeps the sign-in.
@MainActor
final class GitHubBoardSignIn: ObservableObject {
    @Published var code: GitHubLogin.DeviceCode?
    @Published var waiting = false
    @Published var problem: String?
    private var task: Task<Void, Never>?

    /// `item`: the Keychain item a new connection keeps its sign-in in (nil = the connection in use).
    func start(preview: Bool, item: String? = nil, openLink: @escaping (String) -> Void, done: @escaping (GitHubBoard) -> Void) {
        task?.cancel()
        problem = nil
        waiting = true
        if preview {
            code = Self.sampleCode
            return
        }
        task = Task {
            defer {
                waiting = false
                code = nil
            }
            do {
                let c = try await GitHubLogin.start()
                code = c
                openLink(c.verificationURL)
                let tokens = try await GitHubLogin.finish(c, item: item)
                guard tokens.canUseProjects else {
                    problem = "GitHub didn't grant the projects permission. Sign in again and approve it."
                    return
                }
                let me = try await GitHubProjectsAPI(token: { try GitHubLogin.accessToken(item: item) }).viewer()
                done(GitHubBoard(login: me.login, name: me.name))
            } catch is CancellationError {
                return
            } catch {
                problem = "\(error)"
            }
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
        waiting = false
        code = nil
    }

    static let sampleCode = GitHubLogin.DeviceCode(
        deviceCode: "", userCode: "4F2A-9KQD", verificationURL: "https://github.com/login/device", interval: 5,
        expiresAt: Date().addingTimeInterval(900))
}

/// The GitHub half of setup 1: what will happen, then the code while Forge waits for the approval.
struct GitHubBoardSignInPanel: View {
    @ObservedObject var signIn: GitHubBoardSignIn
    let openLink: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let code = signIn.code {
                Text("Enter this code on GitHub").font(Theme.sans(.body, .medium)).foregroundStyle(Theme.text)
                Text(code.userCode).font(Theme.mono(.codeDisplay, .medium)).foregroundStyle(Theme.heatBright).textSelection(.enabled)
                HStack(spacing: 10) {
                    Spinner(heat: true)
                    Text("Waiting for you to approve it in your browser…").font(Theme.sans(.body)).foregroundStyle(Theme.textSec)
                }
                HStack(spacing: 16) {
                    Button("Open the page again") { openLink(code.verificationURL) }.buttonStyle(ForgeButton(kind: .plain))
                    Button("Cancel") { signIn.cancel() }.buttonStyle(ForgeButton(kind: .plain))
                }
                .padding(.top, 4)
            } else {
                Text("Sign in with your browser").font(Theme.sans(.body, .medium)).foregroundStyle(Theme.text)
                Text(
                    "Forge opens GitHub and shows a short code. Enter it there and approve; Forge can then read your "
                        + "project, move its issues between columns, assign itself the ones it works on and comment on them."
                )
                .font(Theme.sans(.body)).foregroundStyle(Theme.textSec).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Image(systemName: "lock").font(Theme.icon(.glyphS))
                    Text("No password here. The sign-in is kept in your Mac's Keychain and nowhere else.")
                }
                .font(Theme.sans(.caption)).foregroundStyle(Theme.textMuted).padding(.top, 4)
            }
        }
        .padding(20)
        .frame(maxWidth: 640, alignment: .leading)
        .panel()
    }
}
