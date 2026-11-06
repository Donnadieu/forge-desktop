import SwiftUI

/// Setup 5: the intelligence provider that works this project's cards (Claude Code, Codex, Kimi or OpenRouter)
/// and the account it uses. A provider keeps any number of accounts, browser sign-ins and API keys alike: add
/// one, switch to another, or clear one. Each keeps its own sign-in, so switching never signs another out. The
/// chosen account is checked with one real call before you can go on.
struct WorkerScreen: View {
    @ObservedObject var model: AppModel
    @State private var provider: IntelligenceProvider = .claude
    /// The chosen account's id, or `AIAccount.addingID` while adding one.
    @State private var selected = AIAccount.addingID
    @State private var newName = ""
    /// The new account uses an API key rather than the browser.
    @State private var newWithKey = false
    @State private var key = ""
    @State private var agentModel = ""
    @State private var busy = false
    @State private var problem: String?
    @State private var works = false
    /// The last check failed because the account's sign-in lapsed: Sign in is the one thing to do.
    @State private var signedOut = false
    @State private var guideOpen = false
    /// The account the guide signs in. A new one is kept only once it's signed in.
    @State private var signingIn: AIAccount?
    /// The account waiting for the person's yes to clear it.
    @State private var clearing: AIAccount?
    @StateObject private var signIn = AgentSignIn()

    /// The provider's name on screen, whichever way it signs in.
    static func name(_ w: SetupChoices.Worker) -> String { IntelligenceProvider(w).name }

    private var accounts: [AIAccount] { model.store.accounts(for: provider) }
    private var adding: Bool { selected == AIAccount.addingID }
    private var chosen: AIAccount? { adding ? nil : model.store.account(selected) }
    private var addingWithBrowser: Bool { adding && provider.signsInWithBrowser && !newWithKey }

    private var browserLine: String {
        provider == .codex
            ? "Opens OpenAI's sign-in for your ChatGPT plan. It gets its own login, so Codex on this Mac stays as it is."
            : "Opens Claude's sign-in for your Pro or Max plan. It gets its own login, so Claude Code on this Mac stays as it is."
    }

    var body: some View {
        SetupFrame(
            model: model,
            question: "Which intelligence provider works this project?",
            detail: "Pick the intelligence provider for \(model.choices.projectName ?? "this project") and the account it uses. "
                + "Forge asks it one small question to be sure it answers.",
            primary: works ? "Continue" : addingWithBrowser ? "Sign in and continue" : "Check and continue",
            primaryEnabled: !signedOut && (!adding || addingWithBrowser || !key.isEmpty),
            busy: busy,
            action: works ? { if let a = chosen { finish(a) } } : primaryAction
        ) {
            VStack(alignment: .leading, spacing: 20) {
                Segmented(options: IntelligenceProvider.allCases.map { ($0, $0.name) }, selection: Binding(get: { provider }, set: pick))
                    .frame(maxWidth: 560)
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel(text: "\(provider.name) accounts")
                    AccountList(
                        accounts: accounts, selection: Binding(get: { selected }, set: select), inUse: model.account?.id,
                        clear: { clearing = $0 }
                    ) { newAccountForm }
                    .frame(maxWidth: 640)
                }
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 12) {
                        Text("Default model").font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
                        Picker("", selection: $agentModel) {
                            ForEach(provider.models, id: \.self) { Text($0.isEmpty ? "Its usual model" : $0).tag($0) }
                        }
                        .labelsHidden()
                        .fixedSize()
                    }
                    Text("Each stage can use another provider, account or model in Workflow Studio.")
                        .font(Theme.sans(12)).foregroundStyle(Theme.textMuted)
                }
                if works { GoodLine(text: "\(chosen?.name ?? provider.name) answered. It's ready to work.") }
                if let problem {
                    Notice(
                        title: signedOut ? "\(chosen?.name ?? provider.name) is signed out." : "\(provider.name) didn't answer.", detail: problem,
                        mono: true
                    ) {
                        if signedOut, let a = chosen {
                            Button("Sign in to \(a.name)") { openGuide(a.preparedForSignIn()) }
                                .buttonStyle(ForgeButton(kind: .primary, large: true))
                                .padding(.leading, 26)
                        }
                    }
                    .frame(maxWidth: 640)
                }
            }
        }
        .overlay {
            if guideOpen, let a = signingIn { SignInGuide(worker: a.worker, account: a.name, signIn: signIn, close: closeGuide) }
        }
        .overlay {
            if let a = clearing {
                ClearAccountSheet(account: a, projects: projects(using: a), cancel: { clearing = nil }) { clear(a) }
            }
        }
        .onAppear(perform: restore)
        .onChange(of: signIn.stage) { _, stage in
            // Signed in: keep the account, close the guide and check again by itself.
            guard stage == .done, let a = signingIn else { return }
            model.keep(a)
            guideOpen = false
            signingIn = nil
            signedOut = false
            selected = a.id
            check(a, secret: WorkerCheck.secret(a))
        }
    }

    private var newAccountForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("", text: $newName).forgeField(hint: "Name it, like Work or Personal", empty: newName.isEmpty, icon: "person")
                .frame(maxWidth: 420)
            if provider.signsInWithBrowser {
                Segmented(options: [(false, "Sign in with your browser"), (true, "Use an API key")], selection: $newWithKey)
                    .frame(maxWidth: 420)
            }
            if !addingWithBrowser {
                SecureField("", text: $key).forgeField(mono: true, hint: provider.keyName, empty: key.isEmpty, icon: "key").frame(maxWidth: 420)
            }
            Text(addingWithBrowser ? browserLine : "Paid per use from that account. The key stays in your Mac's Keychain.")
                .font(Theme.sans(12)).foregroundStyle(Theme.textMuted).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func pick(_ p: IntelligenceProvider) {
        guard p != provider else { return }
        provider = p
        agentModel = p.models[0]
        selected = model.account.flatMap { $0.provider == p ? $0.id : nil } ?? accounts.first?.id ?? AIAccount.addingID
        reset()
    }

    private func select(_ id: String) {
        guard id != selected else { return }
        selected = id
        reset()
    }

    private func reset() {
        key = ""
        newName = ""
        newWithKey = false
        works = false
        problem = nil
        signedOut = false
    }

    private func restore() {
        let a = model.account
        provider = a?.provider ?? model.choices.worker.map(IntelligenceProvider.init) ?? .claude
        selected = a?.id ?? accounts.first?.id ?? AIAccount.addingID
        agentModel = model.choices.model.flatMap { m in provider.models.contains(m) ? m : nil } ?? provider.models[0]
        works = model.preview && model.choices.workerChecked && a != nil
        guard model.preview, let scene = model.sample.scene else { return }
        if scene.hasPrefix("signed-out") {
            problem = "\(provider.name) said: Failed to authenticate: OAuth session expired and could not be refreshed"
            signedOut = true
            if scene.hasSuffix("guide"), let a = chosen {
                signingIn = a
                guideOpen = true
                signIn.preview(link: URL(string: "https://claude.ai/oauth/authorize"), code: provider == .claude)
            }
        }
        if scene == "add-account" { (selected, newName, works) = (AIAccount.addingID, "ConstructEase work", false) }
        if scene == "clear-account" { clearing = model.store.account("sample-personal") }
    }

    private func primaryAction() {
        if let a = chosen { return check(a, secret: WorkerCheck.secret(a)) }
        let a = AIAccount.new(provider, method: addingWithBrowser ? .browser : .key, name: model.store.freeName(provider, newName))
        if addingWithBrowser { return openGuide(a) }
        check(a, secret: key.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private func check(_ a: AIAccount, secret: String?) {
        busy = true
        problem = nil
        let isNew = model.store.account(a.id) == nil
        Task {
            defer { busy = false }
            let chosenModel = agentModel.isEmpty ? nil : agentModel
            let outcome = model.preview ? .works : await WorkerCheck.run(a, model: chosenModel, secret: secret)
            switch outcome {
            case .works:
                if isNew, a.method == .key, let item = a.secretItem, let secret, !model.preview, !Keychain.set(secret, named: item) {
                    problem = "Forge couldn't save the key in your Keychain."
                    return
                }
                if isNew { model.keep(a) }
                selected = a.id
                works = true
                finish(a)
            case .fails(let why):
                problem = why
                signedOut = !isNew && AgentSignIn.command(for: a.worker) != nil && AgentSignIn.looksSignedOut(why)
            }
        }
    }

    private func openGuide(_ a: AIAccount) {
        signingIn = a
        guideOpen = true
        if model.preview { return }
        Task { await signIn.start(a) }
    }

    private func closeGuide() {
        signIn.cancel()
        guideOpen = false
        // A new account that never signed in leaves nothing behind.
        if let a = signingIn, model.store.account(a.id) == nil, !model.preview { Task { await AccountClear.clear(a) } }
        signingIn = nil
    }

    private func projects(using a: AIAccount) -> [String] {
        model.store.projects.filter { $0.accountID == a.id }.map { p in p.repo.map { "\(p.name) · \($0)" } ?? p.name }
    }

    private func clear(_ a: AIAccount) {
        clearing = nil
        Task {
            if !model.preview { await AccountClear.clear(a) }
            model.forget(a)
            if selected == a.id {
                selected = accounts.first?.id ?? AIAccount.addingID
                reset()
            }
        }
    }

    private func finish(_ a: AIAccount) {
        model.choices.accountID = a.id
        model.choices.worker = a.worker
        model.choices.model = agentModel.isEmpty ? nil : agentModel
        model.choices.workerChecked = true
        // A role whose account was cleared meanwhile is dropped.
        model.choices.roles = model.choices.roles.flatMap { model.choices.keptRoles($0, store: model.store) }
        model.next()
    }
}
