import SwiftUI

/// Setup 5: who does the work (Claude Code, Codex or Kimi) and how it signs in (the browser, or an API
/// key kept in the Keychain). Checked with one real call before you can go on.
struct WorkerScreen: View {
    @ObservedObject var model: AppModel
    @State private var agent: SetupChoices.Worker = .claude
    @State private var useKey = false
    @State private var agentModel = ""
    @State private var key = ""
    @State private var busy = false
    @State private var problem: String?
    @State private var works = false
    /// The last check failed because the agent's sign-in lapsed: Sign in is the one thing to do.
    @State private var signedOut = false
    @State private var guideOpen = false
    @StateObject private var signIn = AgentSignIn()

    static let agents: [(SetupChoices.Worker, String)] = [(.claude, "Claude Code"), (.codex, "Codex"), (.kimi, "Kimi")]

    /// The agent's name on screen, whichever way it signs in.
    static func name(_ w: SetupChoices.Worker) -> String {
        switch w.agent {
        case .codex: return "Codex"
        case .kimi: return "Kimi"
        default: return "Claude Code"
        }
    }

    static func models(_ w: SetupChoices.Worker) -> [String] {
        switch w.agent {
        case .codex: return [""]
        case .kimi: return ["kimi-k2.7-code"]
        default: return ["claude-sonnet-5", "claude-opus-5"]
        }
    }

    private var worker: SetupChoices.Worker { SetupChoices.Worker.with(agent, key: useKey || agent == .kimi) }

    private var keyLabel: String {
        switch agent {
        case .codex: return "OpenAI API key"
        case .kimi: return "Moonshot key"
        default: return "Anthropic API key"
        }
    }

    private var browserLine: String {
        switch agent {
        case .codex: return "Uses the Codex sign-in on this Mac (your ChatGPT plan)."
        case .kimi: return "Kimi signs in with a key for now."
        default: return "Uses the Claude Code sign-in on this Mac (your Pro or Max plan)."
        }
    }

    var body: some View {
        SetupFrame(
            model: model,
            question: "Who does the work?",
            detail: "The agent that works the cards. Forge asks it one small question to be sure it answers.",
            primary: works ? "Continue" : "Check and continue",
            primaryEnabled: !signedOut && (!worker.usesKey || !key.isEmpty || hasSavedKey),
            busy: busy,
            action: works ? finish : check
        ) {
            VStack(alignment: .leading, spacing: 20) {
                Segmented(options: Self.agents, selection: Binding(get: { agent }, set: pick)).frame(maxWidth: 480)
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel(text: "How \(Self.name(agent)) signs in")
                    OptionList(
                        options: [(false, "Sign in with your browser"), (true, "Use an API key")],
                        selection: Binding(
                            get: { useKey },
                            set: {
                                useKey = $0
                                reset()
                            }),
                        lines: [false: browserLine, true: "Paid per use from your account. The key stays in your Mac's Keychain."],
                        disabled: agent == .kimi ? [false] : []
                    ) { method in
                        if method {
                            SecureField("", text: $key)
                                .forgeField(mono: true, hint: hasSavedKey ? "\(keyLabel) (saved)" : keyLabel, empty: key.isEmpty, icon: "key")
                                .frame(maxWidth: 420)
                        }
                    }
                    .frame(maxWidth: 640)
                }
                HStack(spacing: 12) {
                    Text("Model").font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
                    Picker("", selection: $agentModel) {
                        ForEach(Self.models(agent), id: \.self) { Text($0.isEmpty ? "Its usual model" : $0).tag($0) }
                    }
                    .labelsHidden()
                    .fixedSize()
                }
                if works { GoodLine(text: "\(Self.name(agent)) answered. It's ready to work.") }
                if let problem {
                    Notice(
                        title: signedOut ? "\(Self.name(agent)) is signed out." : "\(Self.name(agent)) didn't answer.", detail: problem, mono: true
                    ) {
                        if signedOut {
                            Button("Sign in to \(Self.name(agent))") { openGuide() }
                                .buttonStyle(ForgeButton(kind: .primary, large: true))
                                .padding(.leading, 26)
                        }
                    }
                    .frame(maxWidth: 640)
                }
            }
        }
        .overlay {
            if guideOpen { SignInGuide(worker: worker, signIn: signIn, close: closeGuide) }
        }
        .onAppear(perform: restore)
        .onChange(of: signIn.stage) { _, stage in
            // Signed in: close the guide and check again by itself.
            if stage == .done {
                guideOpen = false
                signedOut = false
                check()
            }
        }
    }

    private func pick(_ a: SetupChoices.Worker) {
        guard a != agent else { return }
        agent = a
        agentModel = Self.models(a)[0]
        useKey = a == .kimi
        reset()
    }

    private func reset() {
        key = ""
        works = false
        problem = nil
        signedOut = false
    }

    private var hasSavedKey: Bool { !model.preview && WorkerCheck.keyItem(worker).flatMap { Keychain.get($0) } != nil }

    private func restore() {
        if let w = model.choices.worker {
            agent = w.agent
            useKey = w.usesKey
        }
        agentModel = model.choices.model.flatMap { m in Self.models(agent).contains(m) ? m : nil } ?? Self.models(agent)[0]
        works = model.preview && model.choices.workerChecked
        if model.preview, let scene = model.sample.scene, scene.hasPrefix("signed-out") {
            problem = "\(Self.name(agent)) said: Failed to authenticate: OAuth session expired and could not be refreshed"
            signedOut = true
            if scene.hasSuffix("guide") {
                guideOpen = true
                signIn.preview(link: URL(string: "https://claude.ai/oauth/authorize"), code: agent == .claude)
            }
        }
    }

    private func check() {
        busy = true
        problem = nil
        let typed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        let w = worker
        let k = typed.isEmpty ? WorkerCheck.keyItem(w).flatMap { Keychain.get($0) } : typed
        Task {
            defer { busy = false }
            let chosen = agentModel.isEmpty ? nil : agentModel
            let outcome = model.preview ? .works : await WorkerCheck.run(w, model: chosen, key: k)
            switch outcome {
            case .works:
                if let item = WorkerCheck.keyItem(w), let k, !model.preview, !Keychain.set(k, for: item) {
                    problem = "Forge couldn't save the key in your Keychain."
                    return
                }
                works = true
                finish()
            case .fails(let why):
                problem = why
                signedOut = AgentSignIn.command(for: w) != nil && AgentSignIn.looksSignedOut(why)
            }
        }
    }

    private func openGuide() {
        guideOpen = true
        if model.preview { return }
        Task { await signIn.start(worker) }
    }

    private func closeGuide() {
        signIn.cancel()
        guideOpen = false
    }

    private func finish() {
        model.choices.worker = worker
        model.choices.model = agentModel.isEmpty ? nil : agentModel
        model.choices.workerChecked = true
        model.next()
    }
}
