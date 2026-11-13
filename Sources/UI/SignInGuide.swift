import SwiftUI

/// The small sheet that walks someone through signing an agent back in, in that agent's own words. Closes
/// with its X, Esc, or a click outside it (which also stops the sign-in). It checks again by itself.
struct SignInGuide: View {
    let worker: SetupChoices.Worker
    /// The account's name, when it has one ("Work").
    var account: String?
    @ObservedObject var signIn: AgentSignIn
    let close: () -> Void
    @State private var code = ""

    private var name: String { WorkerScreen.name(worker) }

    private var steps: [String] {
        switch worker.agent {
        case .codex:
            return [
                "Your browser opens OpenAI's sign-in page.", "Sign in with the ChatGPT account that has your plan, and approve Codex.",
                "Come back here. Forge checks by itself and moves on.",
            ]
        default:
            return [
                "Your browser opens \(name)'s sign-in page.",
                account.map { "Sign in with the account you want as \u{201C}\($0)\u{201D}, and approve. Your other accounts stay signed in." }
                    ?? "Sign in with the account that has your plan, and approve.",
                "If the page shows a code, paste it below. Forge checks by itself and moves on.",
            ]
        }
    }

    var body: some View {
        ZStack {
            Theme.bg.opacity(0.72).ignoresSafeArea().onTapGesture(perform: close)
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 16) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Sign in to \(name)").font(Theme.display(.sheetTitle)).foregroundStyle(Theme.text)
                        Text(
                            account.map { "For \($0). Do this once on this Mac. Forge waits for you." }
                                ?? "Do this once on this Mac. Forge waits for you."
                        )
                        .font(Theme.sans(.body)).foregroundStyle(Theme.textSec)
                    }
                    Spacer()
                    Button(action: close) {
                        Image(systemName: "xmark").font(Theme.icon(.glyph, .semibold)).foregroundStyle(Theme.textSec)
                            .frame(width: 28, height: 28)
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(.cancelAction)
                }
                .padding(.horizontal, 24).padding(.vertical, 20)
                .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(Array(steps.enumerated()), id: \.offset) { i, s in step(i + 1, s) }
                    status
                }
                .padding(24)
            }
            .frame(width: 520)
            .background(RoundedRectangle(cornerRadius: Theme.rXl).fill(Theme.surface))
            .clipShape(RoundedRectangle(cornerRadius: Theme.rXl))
            .overlay(RoundedRectangle(cornerRadius: Theme.rXl).stroke(Theme.border))
            .shadow(color: .black.opacity(0.4), radius: 16, y: 4)
        }
    }

    private func step(_ n: Int, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(n)").font(Theme.mono(.caption)).foregroundStyle(Theme.textSec).frame(width: 24, height: 24)
                .overlay(Circle().stroke(Theme.borderHover))
            Text(text).font(Theme.sans(.body)).foregroundStyle(Theme.text).padding(.top, 4).fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder private var status: some View {
        switch signIn.stage {
        case .idle, .waiting:
            if signIn.acceptsCode {
                HStack(spacing: 8) {
                    TextField("", text: $code).forgeField(mono: true, hint: "Paste the code", empty: code.isEmpty)
                    Button("Send") {
                        signIn.send(code: code)
                        code = ""
                    }
                    .buttonStyle(ForgeButton(kind: .primary, large: true))
                    .keyboardShortcut(.defaultAction)
                    .disabled(code.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                .padding(.leading, 36)
            }
            HStack(spacing: 8) {
                Spinner(heat: true)
                Text("Waiting for you to sign in…").font(Theme.sans(.body)).foregroundStyle(Theme.text)
                Spacer()
                if signIn.link != nil {
                    Button("Open the page again") { signIn.openLink() }.buttonStyle(ForgeButton(kind: .plain))
                }
            }
            .padding(.horizontal, 16)
            .frame(height: 44)
            .background(RoundedRectangle(cornerRadius: Theme.rLg).fill(Theme.heatWash))
            .overlay(RoundedRectangle(cornerRadius: Theme.rLg).stroke(Theme.heatBorder))
        case .done:
            GoodLine(text: "Signed in. Checking…")
        case .failed(let why):
            ProblemLine(text: why)
        }
    }
}
