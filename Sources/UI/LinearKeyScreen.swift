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
                HStack(spacing: 12) {
                    Initials(name: model.choices.linearUser ?? "", size: 32)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.choices.linearUser ?? "").font(Theme.sans(14, .medium)).foregroundStyle(Theme.text)
                        Text(model.choices.linearOrg ?? "Linear").font(Theme.sans(12)).foregroundStyle(Theme.textSec)
                    }
                    Spacer()
                    Pill(text: "Connected", tone: .green, dot: Theme.good)
                }
                .padding(20)
                .frame(maxWidth: 640)
                .panel()
                Button("Use a different key") { changing = true }
                    .buttonStyle(ForgeButton(kind: .plain))
                    .padding(.top, 12)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("Linear personal key").font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
                        Spacer()
                        Button("Where do I find it?") { model.openLink("https://linear.app/settings/account/security") }
                            .buttonStyle(ForgeButton(kind: .plain))
                    }
                    SecureField("", text: $key)
                        .forgeField(mono: true, hint: "Paste your key here", empty: key.isEmpty, icon: "lock")
                    HStack(spacing: 8) {
                        Image(systemName: "lock").font(.system(size: 10))
                        Text("Paste it once. It's kept in your Mac's Keychain and nowhere else.")
                    }
                    .font(Theme.sans(11)).foregroundStyle(Theme.textMuted).padding(.top, 4)
                }
                .padding(20)
                .frame(maxWidth: 640)
                .panel()
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
                model.choices.linearURLKey = viewer.organization.urlKey
                changing = false
                key = ""
                model.next()
            } catch {
                problem = "\(error)"
            }
        }
    }
}
