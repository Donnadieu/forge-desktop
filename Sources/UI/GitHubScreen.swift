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

    var body: some View {
        SetupFrame(
            model: model,
            question: "Who signs the commits agents make?",
            detail: "Agents push branches and open pull requests on your GitHub. Their commits carry your name, "
                + "signed so GitHub shows them as Verified.",
            primary: "Check and continue",
            primaryEnabled: user != nil && choiceComplete,
            busy: busy,
            action: start
        ) {
            if accounts.count > 1 {
                Picker("GitHub account", selection: $account) {
                    ForEach(accounts, id: \.self) { Text("@\($0)").tag($0) }
                }
                .frame(maxWidth: 320)
                .padding(.bottom, 10)
            }
            if let user {
                HStack(spacing: 10) {
                    Initials(name: user.name.isEmpty ? user.login : user.name, size: 24)
                    Text("Signed in to GitHub as").font(Theme.sans(14)).foregroundStyle(Theme.text)
                    Text("@\(user.login)").font(Theme.mono(13)).foregroundStyle(Theme.text)
                    Image(systemName: "checkmark.circle.fill").font(.system(size: 12)).foregroundStyle(Theme.good)
                }
                .padding(.bottom, 20)
                choices
            } else if loaded {
                SignInBox(code: code, busy: busy, action: signIn, open: { model.openLink(GitHubSignIn.devicePage) })
            }
            DeviceCodeLine(code: user == nil ? nil : code) { model.openLink(GitHubSignIn.devicePage) }
            ProblemLine(text: problem)
        }
        .task { await load() }
        .onChange(of: account) { _, a in
            guard !model.preview, !a.isEmpty, a != GitHub.account else { return }
            GitHub.account = a
            Task { user = await GitHub.user() }
        }
        .confirmationDialog("Add Forge's signing key to @\(user?.login ?? "") on GitHub?", isPresented: $askRegister) {
            Button("Add the key") { Task { await finishForgeKey(register: true) } }
            Button("Not now", role: .cancel) {}
        } message: {
            Text("This changes your GitHub account: it adds one SSH signing key named \"Forge\". You can remove it in GitHub's settings.")
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
            .font(Theme.sans(13))
            .foregroundStyle(Theme.textSec)
            .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: 640)
        if signing == .forgeKey {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "info.circle").font(.system(size: 11))
                Text("This changes your GitHub account: it adds one SSH signing key named \"Forge\". You can remove it in GitHub's settings.")
                    .fixedSize(horizontal: false, vertical: true)
            }
            .font(Theme.sans(12))
            .foregroundStyle(Theme.textMuted)
            .frame(maxWidth: 620, alignment: .leading)
            .padding(.top, 14)
        }
    }

    private func load() async {
        if model.preview {
            user = model.sample.githubUser
            keys = model.sample.gpgKeys
            loaded = true
            return
        }
        busy = true
        accounts = await GitHub.accounts()
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
            let ok = await GitHubSignIn.run(.signIn) { c in Task { @MainActor in code = c } }
            code = nil
            busy = false
            if ok { user = await GitHub.user() } else { problem = "GitHub sign-in didn't finish. Try again." }
        }
    }

    private func start() {
        problem = nil
        switch signing {
        case .forgeKey: Task { await finishForgeKey(register: false) }
        case .ownGPG:
            guard let k = keys.first(where: { $0.id == gpgKey }) else { return }
            Task { await check(name: k.name, email: k.email, key: k.id) }
        case .unsigned:
            Task { await check(name: user?.name ?? "", email: user?.noreplyEmail ?? "", key: nil) }
        }
    }

    /// Make the key if needed; register it after a yes; then prove it signs.
    private func finishForgeKey(register: Bool) async {
        guard let user else { return }
        busy = true
        defer { busy = false }
        if !ForgeSigningKey.exists, !(await ForgeSigningKey.make(comment: "Forge signing key for @\(user.login)")) {
            problem = "Forge couldn't make a key."
            return
        }
        if !(await ForgeSigningKey.registered()) {
            guard register else {
                askRegister = true
                return
            }
            var result = await ForgeSigningKey.register(title: "Forge")
            if result == .needsPermission {
                let ok = await GitHubSignIn.run(.signingKeyPermission) { c in Task { @MainActor in code = c } }
                code = nil
                guard ok else {
                    problem = "GitHub didn't give Forge the permission to add a signing key."
                    return
                }
                result = await ForgeSigningKey.register(title: "Forge")
            }
            if case .failed(let why) = result {
                problem = "GitHub didn't add the key: \(why)"
                return
            }
        }
        guard await ForgeSigningKey.loadIntoAgent() else {
            problem = "Forge couldn't hand the key to your Mac's key agent."
            return
        }
        await check(name: user.name, email: user.noreplyEmail, key: ForgeSigningKey.publicKeyURL.path)
    }

    private func check(name: String, email: String, key: String?) async {
        busy = true
        defer { busy = false }
        let signs = model.preview ? true : await GitHub.signs(name: name, email: email, signing: signing, key: key)
        guard signs else {
            problem = "A test commit didn't come out signed. Check the key and try again."
            return
        }
        model.choices.githubLogin = user?.login
        model.choices.authorName = name
        model.choices.authorEmail = email
        model.choices.signing = signing
        model.choices.signingKey = key
        model.next()
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
                .font(Theme.sans(14))
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
    let open: () -> Void

    var body: some View {
        if let code {
            HStack(spacing: 14) {
                Text(code).font(Theme.mono(22, .medium)).foregroundStyle(Theme.text).textSelection(.enabled)
                    .padding(.horizontal, 12).frame(height: 40)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.25)))
                Button("Open GitHub", action: open).buttonStyle(ForgeButton(kind: .secondary, icon: "arrow.up.right.square"))
                Text("Type this code there, then come back.").font(Theme.sans(12)).foregroundStyle(Theme.textMuted)
            }
            .padding(.top, 14)
        }
    }
}
