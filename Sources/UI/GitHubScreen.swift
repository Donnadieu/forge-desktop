import SwiftUI

/// Setup 3: GitHub (the `gh` sign-in on this Mac) and who authors and signs the commits agents make.
struct GitHubScreen: View {
    @ObservedObject var model: AppModel
    @State private var accounts: [String] = []
    @State private var account = ""
    @State private var user: GitHub.User?
    @State private var keys: [GitHub.GPGKey] = []
    @State private var signing: SetupChoices.Signing = .forgeKey
    @State private var gpgKey = ""
    @State private var understood = false
    @State private var busy = false
    @State private var loaded = false
    @State private var code: String?
    @State private var problem: String?
    @State private var askRegister = false
    /// The person said yes to adding the key (so Try again doesn't ask twice).
    @State private var approved = false
    /// What the Forge-key step is doing now, shown instead of a bare "Working…".
    @State private var stage: String?
    @State private var signingProblem: SigningProblem?
    @State private var running: Task<Void, Never>?
    @StateObject private var adding = GitHubAccountSignIn()
    static let changeNote =
        "This changes your GitHub account: it adds one SSH signing key named \"\(ForgeSigningKey.title)\". You can remove it in GitHub's settings."

    var body: some View {
        SetupFrame(
            model: model,
            question: "Who signs the commits agents make?",
            detail: "Agents push branches and open pull requests on your GitHub. Their commits carry your name, "
                + "signed so GitHub shows them as Verified.",
            primary: "Check and continue",
            primaryEnabled: user != nil && choiceComplete && signingProblem == nil,
            busy: busy,
            action: start,
            busyText: stage
        ) {
            HStack(spacing: 12) {
                if accounts.count > 1 {
                    Picker("GitHub account", selection: $account) {
                        ForEach(accounts, id: \.self) { Text("@\($0)").tag($0) }
                    }
                    .frame(maxWidth: 320)
                }
                if loaded && !adding.waiting {
                    Button("Add a GitHub account") { addAccount() }.buttonStyle(ForgeButton(kind: .plain, icon: "plus"))
                }
            }
            .padding(.bottom, 10)
            GitHubAccountSignInPanel(signIn: adding, openLink: model.openLink)
            ProblemLine(text: adding.problem)
            if let user {
                HStack(spacing: 10) {
                    Initials(name: user.name.isEmpty ? user.login : user.name, size: 24)
                    Text("Signed in to GitHub as").font(Theme.sans(.emphasis)).foregroundStyle(Theme.text)
                    Text("@\(user.login)").font(Theme.mono(.body)).foregroundStyle(Theme.text)
                    Image(systemName: "checkmark.circle.fill").font(Theme.icon(.glyphM)).foregroundStyle(Theme.good)
                }
                .padding(.bottom, 20)
                choices
            } else if loaded {
                SignInBox(code: code, busy: busy, action: signIn, open: { model.openLink(GitHubSignIn.devicePage) })
            }
            if let p = signingProblem { SigningProblemBox(problem: p, fix: { fix(p.fix) }, unsigned: continueUnsigned) }
            DeviceCodeLine(code: user == nil ? nil : code, cancel: running == nil ? nil : { running?.cancel() }) {
                model.openLink(GitHubSignIn.devicePage)
            }
            ProblemLine(text: problem)
        }
        .task { await load() }
        .onChange(of: signing) { _, _ in
            signingProblem = nil
            problem = nil
        }
        .onChange(of: account) { _, a in
            guard !model.preview, !a.isEmpty, a != GitHub.account else { return }
            GitHub.account = a
            Task { user = await GitHub.user() }
        }
        .confirmationDialog("Add a signing key to @\(user?.login ?? "") on GitHub?", isPresented: $askRegister) {
            Button("Add the key") {
                approved = true
                runForgeKey(register: true)
            }
            Button("Not now", role: .cancel) {}
        } message: {
            Text(Self.changeNote)
        }
    }

    private var choiceComplete: Bool {
        switch signing {
        case .forgeKey: return true
        case .ownGPG: return !gpgKey.isEmpty
        case .unsigned: return understood
        }
    }

    @ViewBuilder private var choices: some View {
        OptionList(
            options: [
                (SetupChoices.Signing.forgeKey, "Me, with a key Forge makes (recommended)"),
                (SetupChoices.Signing.ownGPG, "Me, with my own GPG key"),
                (SetupChoices.Signing.unsigned, "Nobody: unsigned commits"),
            ], selection: $signing
        ) { _ in
            Group {
                switch signing {
                case .forgeKey:
                    Text(
                        "Forge makes a key, keeps it in your Keychain, and adds it to your GitHub account as a signing key. It asks before it adds it."
                    )
                case .ownGPG:
                    if keys.isEmpty {
                        Text("No GPG key on this Mac can sign. Pick another option.")
                    } else {
                        Picker("Key", selection: $gpgKey) {
                            if gpgKey.isEmpty { Text("Choose…").tag("") }
                            ForEach(keys) { Text("\($0.name) <\($0.email)>").tag($0.id) }
                        }
                        .fixedSize()
                        Text("Your key must already be on your GitHub account for commits to show as Verified.")
                    }
                case .unsigned:
                    Toggle("I understand GitHub will show these commits as Unverified.", isOn: $understood)
                }
            }
            .font(Theme.sans(.body))
            .foregroundStyle(Theme.textSec)
            .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: 640)
        if signing == .forgeKey {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "info.circle").font(Theme.icon(.glyph))
                Text(Self.changeNote).fixedSize(horizontal: false, vertical: true)
            }
            .font(Theme.sans(.small))
            .foregroundStyle(Theme.textMuted)
            .frame(maxWidth: 620, alignment: .leading)
            .padding(.top, 14)
        }
    }

    /// Another GitHub account, signed in through Forge itself; picked once it's there.
    private func addAccount() {
        adding.start(openLink: model.openLink) { a in
            model.keep(github: a)
            if !accounts.contains(where: { $0.lowercased() == a.login.lowercased() }) { accounts.append(a.login) }
            account = a.login
        }
    }

    private func load() async {
        if model.preview {
            user = model.sample.githubUser
            keys = model.sample.gpgKeys
            accounts = ["samrivera", "samrivera-andela"] + (model.store.githubAccounts ?? []).map(\.login)
            account = "samrivera"
            loaded = true
            switch model.sample.scene {
            case "signing-permission":
                signingProblem = SigningProblem(
                    text:
                        "GitHub still doesn't let Forge add signing keys to @samrivera. Approve the permission while signed in to GitHub as @samrivera.",
                    fix: .permission)
            case "signing-code":
                (busy, stage, code) = (true, "Waiting for you to approve on GitHub…", "WDJB-MJHT")
            default: break
            }
            return
        }
        busy = true
        accounts = await GitHub.accounts(adding: (model.store.githubAccounts ?? []).map(\.login))
        let pick = model.choices.githubLogin.flatMap { l in accounts.first { $0.lowercased() == l.lowercased() } } ?? accounts.first
        GitHub.account = pick
        account = pick ?? ""
        user = await GitHub.user()
        keys = await GitHub.gpgKeys()
        if let s = model.choices.signing { signing = s }
        if signing == .ownGPG, let k = model.choices.signingKey { gpgKey = k }
        loaded = true
        busy = false
    }

    private func signIn() {
        busy = true
        problem = nil
        Task {
            let why = await GitHubSignIn.run(.signIn) { c in
                Task { @MainActor in
                    code = c
                    model.openLink(GitHubSignIn.devicePage)
                }
            }
            code = nil
            busy = false
            if let why { problem = "GitHub sign-in didn't finish: \(why)" } else { user = await GitHub.user() }
        }
    }

    private func start() {
        problem = nil
        signingProblem = nil
        switch signing {
        case .forgeKey: runForgeKey(register: approved)
        case .ownGPG:
            guard let k = keys.first(where: { $0.id == gpgKey }) else { return }
            Task { await check(name: k.name, email: k.email, key: k.id) }
        case .unsigned:
            Task { await check(name: user?.name ?? "", email: user?.noreplyEmail ?? "", key: nil) }
        }
    }

    /// Make the key if needed; add it to GitHub after a yes (asking GitHub for the permission if needed); prove it
    /// signs. Any stop shows its reason and the one fix.
    private func runForgeKey(register: Bool) {
        guard let user, running == nil else { return }
        if model.preview { return }
        busy = true
        signingProblem = nil
        let account = GitHub.account ?? user.login
        running = Task {
            let outcome = await ForgeKeyFlow.run(
                login: user.login, name: user.name, email: user.noreplyEmail, register: register,
                stage: { s in Task { @MainActor in stage = s } },
                grant: {
                    let why = await SigningPermission.grant(account: account) { c, url in
                        Task { @MainActor in
                            code = c
                            model.openLink(url)
                        }
                    }
                    await MainActor.run { code = nil }
                    return why
                })
            (busy, stage, code, running) = (false, nil, nil, nil)
            switch outcome {
            case .ask: askRegister = true
            case .problem(let p): signingProblem = p
            case .signs(let key): save(name: user.name, email: user.noreplyEmail, key: key)
            }
        }
    }

    private func fix(_ f: SigningProblem.Fix) {
        switch f {
        case .permission:
            approved = true
            runForgeKey(register: true)
        case .newKey:
            ForgeSigningKey.forget()
            approved = false
            runForgeKey(register: false)
        case .tryAgain: runForgeKey(register: approved)
        }
    }

    /// The way on without signing: GitHub shows these commits as Unverified; Settings can change it later.
    private func continueUnsigned() {
        signing = .unsigned
        understood = true
        Task { await check(name: user?.name ?? "", email: user?.noreplyEmail ?? "", key: nil) }
    }

    private func check(name: String, email: String, key: String?) async {
        busy = true
        defer { busy = false }
        if !model.preview, let why = await GitHub.signCheck(name: name, email: email, signing: signing, key: key) {
            problem = "A test commit with your key didn't sign: \(why)"
            return
        }
        save(name: name, email: email, key: key)
    }

    private func save(name: String, email: String, key: String?) {
        model.choices.githubLogin = user?.login
        model.choices.authorName = name
        model.choices.authorEmail = email
        model.choices.signing = signing
        model.choices.signingKey = key
        model.next()
    }
}

/// Why the Forge key isn't ready, its one fix, and the way on without signing.
struct SigningProblemBox: View {
    let problem: SigningProblem
    let fix: () -> Void
    let unsigned: () -> Void

    var body: some View {
        Notice(title: problem.text) {
            HStack(spacing: 16) {
                Button(problem.fixTitle, action: fix).buttonStyle(ForgeButton(kind: .fix))
                Button(SigningProblem.unsignedTitle, action: unsigned).buttonStyle(ForgeButton(kind: .plain))
            }
        }
        .frame(maxWidth: 640, alignment: .leading)
        .padding(.top, 14)
    }
}

/// Shown when `gh` isn't signed in on this Mac.
struct SignInBox: View {
    let code: String?
    let busy: Bool
    let action: () -> Void
    let open: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Forge uses your GitHub sign-in on this Mac. You're not signed in yet.")
                .font(Theme.sans(.emphasis))
                .foregroundStyle(Theme.textSec)
            Button("Sign in to GitHub", action: action)
                .buttonStyle(ForgeButton(kind: .fix, large: true))
                .disabled(busy)
            DeviceCodeLine(code: code, open: open)
        }
    }
}

/// The one-time code GitHub asks for, and the page to type it on.
struct DeviceCodeLine: View {
    let code: String?
    var cancel: (() -> Void)? = nil
    let open: () -> Void

    var body: some View {
        if let code {
            HStack(spacing: 14) {
                Text(code).font(Theme.mono(.codeDisplaySmall, .medium)).foregroundStyle(Theme.text).textSelection(.enabled)
                    .padding(.horizontal, 12).frame(height: 40)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.25)))
                Button("Open GitHub", action: open).buttonStyle(ForgeButton(kind: .secondary, icon: "arrow.up.right.square"))
                Text("Type this code there, then come back.").font(Theme.sans(.small)).foregroundStyle(Theme.textMuted)
                if let cancel { Button("Cancel", action: cancel).buttonStyle(ForgeButton(kind: .plain)) }
            }
            .padding(.top, 14)
        }
    }
}
