import SwiftUI

/// Setup 1: paste the Linear key once. It goes into the Keychain after one real call proves it works.
struct LinearKeyScreen: View {
    @ObservedObject var model: AppModel
    @State private var key = ""
    @State private var busy = false
    @State private var problem: String?
    @State private var changing = false

    private var connected: Bool { model.choices.linearUser != nil && !changing }

    var body: some View {
        SetupFrame(
            model: model,
            question: "Connect your Linear",
            detail: "Forge reads your cards and moves them along the board. Paste a Linear personal key once; "
                + "it's kept in your Mac's Keychain and nowhere else.",
            primary: connected ? "Continue" : "Check and continue",
            primaryEnabled: connected || !key.trimmingCharacters(in: .whitespaces).isEmpty,
            busy: busy,
            action: connected ? { model.next() } : check
        ) {
            if connected {
                GoodLine(text: "Connected as \(model.choices.linearUser ?? "") in \(model.choices.linearOrg ?? "Linear").")
                Button("Use a different key") { changing = true }
                    .buttonStyle(.link)
                    .padding(.top, 8)
            } else {
                SecureField("Linear key", text: $key)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 14, design: .monospaced))
                    .frame(maxWidth: 460)
                Button("Where do I find it?") { model.openLink("https://linear.app/settings/account/security") }
                    .buttonStyle(.link)
                    .padding(.top, 8)
                ProblemLine(text: problem)
            }
        }
    }

    private func check() {
        let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
        busy = true
        problem = nil
        Task {
            defer { busy = false }
            do {
                let viewer = try await LinearAPI(key: k).viewer()
                guard model.preview || Keychain.set(k, for: .linearKey) else {
                    problem = "Forge couldn't save the key in your Keychain."
                    return
                }
                model.choices.linearUser = viewer.name
                model.choices.linearOrg = viewer.organization.name
                changing = false
                key = ""
                model.next()
            } catch {
                problem = "\(error)"
            }
        }
    }
}
