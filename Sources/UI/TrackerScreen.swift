import SwiftUI

/// Setup 1: the tracker connection the project uses. Pick a kind (Linear, Basecamp or GitHub Issues), then one of
/// its connections on this Mac, or connect another: there can be several of each, each its own sign-in in its own
/// Keychain item, so connecting one never signs another out. Linear takes a personal key, checked with one real
/// call; Basecamp and GitHub sign in through the browser with a short code.
struct TrackerScreen: View {
    @ObservedObject var model: AppModel
    @State private var picked: Tracker = .linear
    /// The connection picked (`TrackerRecord.id`), or `adding`.
    @State private var pick = TrackerScreen.adding
    /// Sign the picked connection in again (its sign-in ran out, or a different Linear key).
    @State private var again = false
    @State private var key = ""
    @State private var name = ""
    @State private var busy = false
    @State private var problem: String?
    @StateObject private var basecamp = BasecampSignIn()
    @StateObject private var github = GitHubBoardSignIn()

    static let adding = "+new"

    private var list: [TrackerRecord] { model.store.connections(picked) }
    private var current: TrackerRecord? { list.first { $0.id == pick } }
    private var signingIn: Bool { pick == Self.adding || again }

    var body: some View {
        SetupFrame(
            model: model,
            question: "Which tracker holds your work?",
            detail: "Forge reads the cards on your tracker and moves them along the board. Connect as many as you like, "
                + "even two of the same kind; each sign-in is kept in your Mac's Keychain and nowhere else.",
            primary: primaryTitle,
            primaryEnabled: primaryEnabled,
            busy: busy || basecamp.waiting || github.waiting,
            action: primaryAction
        ) {
            Segmented(options: Tracker.allCases.map { ($0, $0.name) }, selection: $picked)
                .frame(maxWidth: 420)
                .padding(.bottom, 18)
            VStack(spacing: 8) {
                ForEach(list, id: \.id) { t in connectionRow(t) }
                addRow
            }
            .frame(maxWidth: 720)
            ProblemLine(text: problem ?? (picked == .basecamp ? basecamp.problem : picked == .github ? github.problem : nil))
        }
        .onAppear {
            picked = model.sample.tracker ?? model.choices.board
            choose()
            if model.preview && model.sample.scene == "basecamp-code" {
                basecamp.start(preview: true, openLink: { _ in }) { _ in }
            }
            if model.preview && model.sample.scene == "github-code" {
                github.start(preview: true, openLink: { _ in }) { _ in }
            }
        }
        .onChange(of: picked) { _, _ in
            problem = nil
            choose()
        }
    }

    /// Picks the running project's connection when it's this kind, else the first one, else Connect.
    private func choose() {
        again = false
        let mine = model.choices.board == picked ? model.choices.connection : nil
        pick = list.first { $0.id == mine }?.id ?? list.first?.id ?? Self.adding
    }

    private func connectionRow(_ t: TrackerRecord) -> some View {
        let on = t.id == pick
        let users = model.store.users(of: t.id)
        let inUse = model.choices.board == picked && model.choices.connection == t.id && model.choices.trackerUser != nil
        return row(on: on) {
            HStack(spacing: 8) {
                Text(t.title).font(Theme.sans(.body, .semibold)).foregroundStyle(Theme.text)
                if inUse { Pill(text: "In use", tone: .green, dot: Theme.good) }
            }
            Text(t.line + (users.isEmpty ? "" : " · used by \(users.map(\.name).joined(separator: ", "))"))
                .font(Theme.sans(.body)).foregroundStyle(Theme.textSec).fixedSize(horizontal: false, vertical: true)
            if on && again { signInPanel.padding(.top, 6) }
            if on && !again {
                Button(t.kind == .linear ? "Use a different key" : "Sign in again") { again = true }
                    .buttonStyle(ForgeButton(kind: .plain)).padding(.top, 4)
            }
        } trailing: {
            if users.isEmpty {
                Button("Clear") { model.ask = .clearConnection(t) }.buttonStyle(ForgeButton(kind: .ghost, icon: "xmark"))
            }
        }
        .onTapGesture {
            if pick != t.id { again = false }
            pick = t.id
        }
    }

    private var addRow: some View {
        row(on: pick == Self.adding) {
            Text(list.isEmpty ? "Connect \(picked.name)" : "Connect another \(picked.name)").font(Theme.sans(.body, .semibold))
                .foregroundStyle(Theme.text)
            Text("A new sign-in. Your other connections stay signed in.").font(Theme.sans(.body)).foregroundStyle(Theme.textSec)
            if pick == Self.adding {
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel(text: "Name")
                    TextField("", text: $name).forgeField(hint: "\(picked.name) for work", empty: name.isEmpty)
                        .frame(maxWidth: 360)
                    signInPanel.padding(.top, 6)
                }
                .padding(.top, 6)
            }
        } trailing: {
            EmptyView()
        }
        .onTapGesture { pick = Self.adding }
    }

    private func row<L: View, T: View>(on: Bool, @ViewBuilder _ label: () -> L, @ViewBuilder trailing: () -> T) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Radio(on: on).padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) { label() }
            Spacer(minLength: 0)
            trailing()
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: Theme.rLg).fill(on ? Theme.surfaceHover : Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: Theme.rLg).stroke(on ? Theme.borderHover : Theme.border))
        .contentShape(Rectangle())
    }

    @ViewBuilder private var signInPanel: some View {
        switch picked {
        case .linear: linearPanel
        case .github: GitHubBoardSignInPanel(signIn: github, openLink: model.openLink)
        case .basecamp: BasecampSignInPanel(signIn: basecamp, openLink: model.openLink)
        }
    }

    private var primaryTitle: String {
        if !signingIn { return "Continue" }
        return picked == .linear ? "Check and continue" : "Sign in with your browser"
    }

    private var primaryEnabled: Bool {
        if !signingIn { return current != nil }
        switch picked {
        case .linear: return !key.trimmingCharacters(in: .whitespaces).isEmpty
        case .basecamp: return !basecamp.waiting
        case .github: return !github.waiting
        }
    }

    /// The connection a sign-in goes to: the picked one again, or a new one with its own Keychain item.
    private var target: TrackerRecord {
        if again, let t = current { return t }
        var t = TrackerRecord.new(picked)
        let typed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        t.name = typed.isEmpty ? nil : typed
        return t
    }

    private func primaryAction() {
        if !signingIn, let t = current { return use(t) }
        var t = target
        switch picked {
        case .linear:
            checkLinear(t)
        case .github:
            github.start(preview: model.preview, item: t.item, openLink: model.openLink) { board in
                (t.login, t.user, t.org) = (board.login, board.name ?? board.login, "@\(board.login)")
                finish(t)
            }
        case .basecamp:
            basecamp.start(preview: model.preview, item: t.item, openLink: model.openLink) { board in
                (t.accountID, t.personID, t.user, t.org) = (board.accountID, board.personID, board.personName, board.accountName ?? t.org)
                finish(t)
            }
        }
    }

    private func finish(_ t: TrackerRecord) {
        model.keep(connection: t)
        key = ""
        name = ""
        again = false
        use(t)
    }

    /// The project uses this connection. Another connection means another project: the project step asks again,
    /// and the project that ran keeps its answers.
    private func use(_ t: TrackerRecord) {
        if model.choices.connection != t.id || model.choices.board != t.kind {
            model.store.leave(model.choices)
            for field in [\SetupChoices.projectSlug, \.projectID, \.projectName, \.teamID, \.teamName] { model.choices[keyPath: field] = nil }
            model.choices.columnsReady = false
        }
        t.apply(to: &model.choices)
        model.next()
    }

    private var linearPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Linear personal key").font(Theme.sans(.body, .medium)).foregroundStyle(Theme.text)
                Spacer()
                Button("Where do I find it?") { model.openLink("https://linear.app/settings/account/security") }
                    .buttonStyle(ForgeButton(kind: .plain))
            }
            SecureField("", text: $key)
                .forgeField(mono: true, hint: "Paste your key here", empty: key.isEmpty, icon: "lock")
            HStack(spacing: 8) {
                Image(systemName: "lock").font(Theme.icon(.glyphS))
                Text("Paste it once. It's kept in your Mac's Keychain and nowhere else.")
            }
            .font(Theme.sans(.caption)).foregroundStyle(Theme.textMuted).padding(.top, 4)
        }
        .padding(20)
        .frame(maxWidth: 640)
        .panel()
    }

    private func checkLinear(_ target: TrackerRecord) {
        let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
        busy = true
        problem = nil
        Task {
            defer { busy = false }
            do {
                let viewer = try await LinearAPI(key: k).viewer()
                guard model.preview || Keychain.set(k, named: target.item) else {
                    problem = "Forge couldn't save the key in your Keychain."
                    return
                }
                var t = target
                (t.user, t.org, t.urlKey) = (viewer.name, viewer.organization.name, viewer.organization.urlKey)
                finish(t)
            } catch {
                problem = "\(error)"
            }
        }
    }
}
