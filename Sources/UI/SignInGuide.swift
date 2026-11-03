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
            Color.black.opacity(0.45).ignoresSafeArea().onTapGesture(perform: close)
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Sign in to \(name)").font(.system(size: 18, weight: .semibold))
                    Spacer()
                    Button(action: close) { Image(systemName: "xmark") }
                        .buttonStyle(.plain)
                        .keyboardShortcut(.cancelAction)
                }
                step(1, "Your browser opens \(name)'s sign-in page.")
                step(2, "Sign in with the account that has your plan, and approve.")
                step(3, "Come back here. Forge checks by itself and moves on.")
                Divider()
                status
            }
            .padding(24)
            .frame(width: 440)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color(nsColor: .windowBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.secondary.opacity(0.25)))
        }
    }

    private func step(_ n: Int, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(n)").font(.system(size: 12, weight: .bold)).frame(width: 20, height: 20)
                .background(Circle().fill(Color.accentColor.opacity(0.25)))
            Text(text).font(.system(size: 13))
        }
    }

    @ViewBuilder private var status: some View {
        switch signIn.stage {
        case .idle, .waiting:
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text("Waiting for you to finish in the browser…").font(.system(size: 13)).foregroundStyle(.secondary)
                Spacer()
                if signIn.link != nil { Button("Open the page again") { signIn.openLink() } }
            }
            if signIn.acceptsCode {
                HStack {
                    TextField("If the page shows a code, paste it here", text: $code).textFieldStyle(.roundedBorder)
                    Button("Send") {
                        signIn.send(code: code)
                        code = ""
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(code.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        case .done:
            GoodLine(text: "Signed in. Checking…")
        case .failed(let why):
            ProblemLine(text: why)
        }
    }
}
