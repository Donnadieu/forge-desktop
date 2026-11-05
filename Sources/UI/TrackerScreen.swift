import SwiftUI

/// Setup 1: where the cards live (Linear or Basecamp), and signing in to it. Linear takes a personal key,
/// checked with one real call; Basecamp signs in through the browser with a short code. Either way the
/// secret goes only into the Keychain.
struct TrackerScreen: View {
    @ObservedObject var model: AppModel
    @State private var picked: Tracker = .linear
    @State private var key = ""
    @State private var busy = false
    @State private var problem: String?
    @State private var changing = false
    @StateObject private var basecamp = BasecampSignIn()

    /// The picked tracker is signed in and is the one setup saved.
    private var connected: Bool {
        guard !changing, model.choices.board == picked else { return false }
        return model.choices.trackerUser != nil
    }

    var body: some View {
        SetupFrame(
            model: model,
            question: "Where do your cards live?",
            detail: "Forge reads your cards and moves them along the board. Pick where your team keeps them, then sign in once; "
                + "the sign-in is kept in your Mac's Keychain and nowhere else.",
            primary: primaryTitle,
            primaryEnabled: primaryEnabled,
            busy: busy || basecamp.waiting,
            action: primaryAction
        ) {
            Segmented(options: Tracker.allCases.map { ($0, $0.name) }, selection: $picked)
                .frame(maxWidth: 320)
                .padding(.bottom, 18)
            if connected {
                ConnectedPanel(name: model.choices.trackerUser ?? "", org: model.choices.trackerOrg ?? picked.name)
                Button(picked == .linear ? "Use a different key" : "Sign in again") { changing = true }
                    .buttonStyle(ForgeButton(kind: .plain))
                    .padding(.top, 12)
            } else if picked == .linear {
                linearPanel
            } else {
                BasecampSignInPanel(signIn: basecamp, openLink: model.openLink)
            }
            ProblemLine(text: problem ?? (picked == .basecamp ? basecamp.problem : nil))
        }
        .onAppear {
            picked = model.sample.tracker ?? model.choices.board
            if model.preview && model.sample.scene == "basecamp-code" {
                basecamp.start(preview: true, openLink: { _ in }) { _ in }
            }
        }
        .onChange(of: picked) { _, _ in problem = nil }
    }

    private var primaryTitle: String {
        if connected { return "Continue" }
        return picked == .linear ? "Check and continue" : "Sign in with your browser"
    }

    private var primaryEnabled: Bool {
        if connected { return true }
        return picked == .linear ? !key.trimmingCharacters(in: .whitespaces).isEmpty : !basecamp.waiting
    }

    private func primaryAction() {
        if connected { return model.next() }
        if picked == .linear { return checkLinear() }
        basecamp.start(preview: model.preview, openLink: model.openLink) { board in
            switchTo(.basecamp)
            model.choices.basecamp = board
            changing = false
            model.next()
        }
    }

    /// A different tracker means a different project: the project step asks again.
    private func switchTo(_ t: Tracker) {
        if model.choices.board != t {
            model.choices.projectSlug = nil
            model.choices.projectID = nil
            model.choices.projectName = nil
            model.choices.columnsReady = false
        }
        model.choices.tracker = t
    }

    private var linearPanel: some View {
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
    }

    private func checkLinear() {
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
                switchTo(.linear)
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

/// Who is signed in, with a Connected pill.
struct ConnectedPanel: View {
    let name: String
    let org: String

    var body: some View {
        HStack(spacing: 12) {
            Initials(name: name, size: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(Theme.sans(14, .medium)).foregroundStyle(Theme.text)
                Text(org).font(Theme.sans(12)).foregroundStyle(Theme.textSec)
            }
            Spacer()
            Pill(text: "Connected", tone: .green, dot: Theme.good)
        }
        .padding(20)
        .frame(maxWidth: 640)
        .panel()
    }
}
