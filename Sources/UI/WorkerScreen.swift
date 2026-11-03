import SwiftUI

/// Setup 5: who does the work. Checked with one real call before you can go on.
struct WorkerScreen: View {
    @ObservedObject var model: AppModel
    @State private var worker: SetupChoices.Worker = .claude
    @State private var agentModel = ""
    @State private var key = ""
    @State private var busy = false
    @State private var problem: String?
    @State private var works = false
    /// The last check failed because the agent's sign-in lapsed: Sign in is the one thing to do.
    @State private var signedOut = false
    @State private var guideOpen = false
    @StateObject private var signIn = AgentSignIn()

    struct Option {
        let worker: SetupChoices.Worker
        let title: String
        let line: String
        let models: [String]
        let keyLabel: String?
    }

    static let options: [Option] = [
        Option(
            worker: .claude, title: "Claude Code", line: "Uses the Claude Code sign-in on this Mac (your Pro or Max plan).",
            models: ["claude-sonnet-5", "claude-opus-5"], keyLabel: nil),
        Option(
            worker: .codex, title: "Codex", line: "Uses the Codex sign-in on this Mac (your ChatGPT plan).",
            models: [""], keyLabel: nil),
        Option(
            worker: .kimi, title: "Kimi", line: "Uses the Kimi Code tool on this Mac with your Moonshot key.",
            models: ["kimi-k2.7-code"], keyLabel: "Moonshot key"),
        Option(
            worker: .apiKey, title: "An Anthropic API key", line: "Claude Code paid per use from your Anthropic account.",
            models: ["claude-sonnet-5", "claude-opus-5"], keyLabel: "Anthropic API key"),
    ]

    private var option: Option { Self.options.first { $0.worker == worker } ?? Self.options[0] }

    var body: some View {
        SetupFrame(
            model: model,
            question: "Who does the work?",
            detail: "The agent that works the cards. Forge asks it one small question to be sure it answers.",
            primary: works ? "Continue" : "Check and continue",
            primaryEnabled: !signedOut && (option.keyLabel == nil || !key.isEmpty || hasSavedKey),
            busy: busy,
            action: works ? finish : check
        ) {
            Picker("", selection: $worker) {
                ForEach(Self.options, id: \.worker) { Text($0.title).tag($0.worker) }
            }
            .pickerStyle(.radioGroup)
            .labelsHidden()
            Text(option.line)
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .padding(.top, 10)
            HStack(spacing: 16) {
                Picker("Model", selection: $agentModel) {
                    ForEach(option.models, id: \.self) { Text($0.isEmpty ? "Its usual model" : $0).tag($0) }
                }
                .frame(maxWidth: 260)
                if let label = option.keyLabel {
                    SecureField(hasSavedKey ? "\(label) (saved)" : label, text: $key)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 300)
                }
            }
            .padding(.top, 14)
            if works { GoodLine(text: "\(option.title) answered.").padding(.top, 12) }
            ProblemLine(text: problem)
            if signedOut {
                Button("Sign in to \(option.title)") { openGuide() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .padding(.top, 12)
            }
        }
        .overlay {
            if guideOpen {
                SignInGuide(name: option.title, signIn: signIn, close: closeGuide)
            }
        }
        .onAppear(perform: restore)
        .onChange(of: worker) { _, _ in
            agentModel = option.models[0]
            key = ""
            works = false
            problem = nil
            signedOut = false
        }
        .onChange(of: signIn.stage) { _, stage in
            // Signed in: close the guide and check again by itself.
            if stage == .done {
                guideOpen = false
                signedOut = false
                check()
            }
        }
    }

    private var keyItem: Keychain.Item? {
        switch worker {
        case .apiKey: return .anthropicKey
        case .kimi: return .kimiKey
        case .claude, .codex: return nil
        }
    }

    private var hasSavedKey: Bool { !model.preview && keyItem.flatMap { Keychain.get($0) } != nil }

    private func restore() {
        if let w = model.choices.worker { worker = w }
        agentModel = model.choices.model.flatMap { m in option.models.contains(m) ? m : nil } ?? option.models[0]
        works = model.preview && model.choices.workerChecked
        if model.preview, let scene = model.sample.scene, scene.hasPrefix("signed-out") {
            problem = "Claude Code said: Failed to authenticate: OAuth session expired and could not be refreshed"
            signedOut = true
            if scene == "signed-out-guide" {
                guideOpen = true
                signIn.preview(link: URL(string: "https://claude.ai/oauth/authorize"))
            }
        }
    }

    private func check() {
        busy = true
        problem = nil
        let typed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        let k = typed.isEmpty ? keyItem.flatMap { Keychain.get($0) } : typed
        Task {
            defer { busy = false }
            let chosen = agentModel.isEmpty ? nil : agentModel
            let outcome = model.preview ? .works : await WorkerCheck.run(worker, model: chosen, key: k)
            switch outcome {
            case .works:
                if let item = keyItem, let k, !model.preview, !Keychain.set(k, for: item) {
                    problem = "Forge couldn't save the key in your Keychain."
                    return
                }
                works = true
                finish()
            case .fails(let why):
                problem = why
                signedOut = AgentSignIn.command(for: worker) != nil && AgentSignIn.looksSignedOut(why)
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
