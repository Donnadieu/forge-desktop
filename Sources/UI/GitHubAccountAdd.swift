import SwiftUI

/// Adding a GitHub account beside the ones the GitHub CLI has: GitHub's device sign-in, kept in the Keychain
/// under the account's own item (`GitHubAccountRecord`). The GitHub CLI's own accounts are never touched.
@MainActor
final class GitHubAccountSignIn: ObservableObject {
    @Published var code: GitHubLogin.DeviceCode?
    @Published var waiting = false
    @Published var problem: String?
    private var task: Task<Void, Never>?

    func start(openLink: @escaping (String) -> Void, done: @escaping (GitHubAccountRecord) -> Void) {
        task?.cancel()
        problem = nil
        waiting = true
        task = Task {
            defer {
                waiting = false
                code = nil
            }
            do {
                let c = try await GitHubLogin.start()
                code = c
                openLink(c.verificationURL)
                let t = try await GitHubLogin.finish(c, item: "")
                let me = try await GitHubProjectsAPI(token: { t.accessToken }).viewer()
                let account = GitHubAccountRecord(login: me.login, name: me.name)
                guard GitHubLogin.save(t, item: account.secretItem) else {
                    problem = "Forge couldn't keep the sign-in in your Keychain."
                    return
                }
                done(account)
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
}

/// The code to approve while Forge waits, under the account picker.
struct GitHubAccountSignInPanel: View {
    @ObservedObject var signIn: GitHubAccountSignIn
    let openLink: (String) -> Void

    var body: some View {
        if let code = signIn.code {
            VStack(alignment: .leading, spacing: 10) {
                Text("Approve this code on GitHub, signed in as the account to add").font(Theme.sans(.body, .medium)).foregroundStyle(Theme.text)
                Text(code.userCode).font(Theme.mono(.codeDisplay, .medium)).foregroundStyle(Theme.heatBright).textSelection(.enabled)
                HStack(spacing: 10) {
                    Spinner(heat: true)
                    Text("Waiting for you to approve it in your browser…").font(Theme.sans(.body)).foregroundStyle(Theme.textSec)
                }
                HStack(spacing: 16) {
                    Button("Open the page again") { openLink(code.verificationURL) }.buttonStyle(ForgeButton(kind: .plain))
                    Button("Cancel") { signIn.cancel() }.buttonStyle(ForgeButton(kind: .plain))
                }
            }
            .padding(20)
            .frame(maxWidth: 640, alignment: .leading)
            .panel()
            .padding(.bottom, 16)
        }
    }
}
