import SwiftUI

/// The small guide that walks someone through signing an agent back in. Closes with its X, Esc, or a
/// click outside it (which also stops the sign-in).
struct SignInGuide: View {
    let name: String
    @ObservedObject var signIn: AgentSignIn
    let close: () -> Void
    @State private var code = ""

    var body: some View {
        ZStack {
            Color.black.opacity(0.5).ignoresSafeArea().onTapGesture(perform: close)
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Sign in to \(name)").font(Theme.display(22)).foregroundStyle(Theme.text)
                        Text("Do this once on this Mac. Forge waits for you.").font(Theme.sans(13)).foregroundStyle(Theme.textSec)
                    }
                    Spacer()
                    Button(action: close) {
                        Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.textSec)
                            .frame(width: 24, height: 24).background(Circle().fill(Theme.surfaceHover))
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(.cancelAction)
                }
                VStack(alignment: .leading, spacing: 10) {
                    step(1, "Your browser opens \(name)'s sign-in page.")
                    step(2, "Sign in with the account that has your plan, and approve.")
                    step(3, "Come back here. Forge checks by itself and moves on.")
                }
                status
            }
            .padding(24)
            .frame(width: 480)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border.opacity(0.6)))
            .shadow(color: .black.opacity(0.5), radius: 30, y: 12)
        }
    }

    private func step(_ n: Int, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(n)").font(Theme.mono(11)).foregroundStyle(Theme.textSec).frame(width: 20, height: 20)
                .background(Circle().fill(Color.white.opacity(0.08)))
            Text(text).font(Theme.sans(14)).foregroundStyle(Theme.text)
        }
    }

    @ViewBuilder private var status: some View {
        switch signIn.stage {
        case .idle, .waiting:
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text("Waiting for you to finish in the browser…").font(Theme.sans(13)).foregroundStyle(Theme.text)
                Spacer()
            }
            .padding(.horizontal, 14)
            .frame(height: 42)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.heat.opacity(0.12)))
            if signIn.acceptsCode {
                VStack(alignment: .leading, spacing: 8) {
                    Text("If the page shows a code, paste it here").font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
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
                }
            }
            if signIn.link != nil {
                Button("Open the page again") { signIn.openLink() }
                    .buttonStyle(ForgeButton(kind: .plain, icon: "arrow.up.right.square"))
            }
        case .done:
            GoodLine(text: "Signed in. Checking…")
        case .failed(let why):
            ProblemLine(text: why)
        }
    }
}
