import SwiftUI

/// Basecamp's device sign-in, step by step: Forge asks Basecamp for a code, opens the approval page in the
/// browser, and waits. The person only approves; Forge then reads who they are and keeps the sign-in.
@MainActor
final class BasecampSignIn: ObservableObject {
    @Published var code: BasecampLogin.DeviceCode?
    @Published var waiting = false
    @Published var problem: String?
    private var task: Task<Void, Never>?

    /// `item`: the Keychain item a new connection keeps its sign-in in (nil = the connection in use).
    func start(preview: Bool, item: String? = nil, openLink: @escaping (String) -> Void, done: @escaping (BasecampBoard) -> Void) {
        task?.cancel()
        problem = nil
        waiting = true
        if preview {
            code = Self.sampleCode
            return
        }
        task = Task {
            defer {
                waiting = false
                code = nil
            }
            do {
                let c = try await BasecampLogin.start()
                code = c
                openLink(c.verificationURL)
                let tokens = try await BasecampLogin.finish(c, item: item)
                guard let account = tokens.accountID else {
                    problem = "Basecamp didn't say which account this sign-in is for. Sign in again."
                    return
                }
                let me = try await BasecampAPI(accountID: account, token: { try await BasecampLogin.accessToken(item: item).accessToken }).me()
                done(BasecampBoard(accountID: account, accountName: nil, personID: String(me.id), personName: me.name))
            } catch is CancellationError {
                return
            } catch {
                problem = "\(error)"
            }
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
        waiting = false
        code = nil
    }

    static let sampleCode = BasecampLogin.DeviceCode(
        deviceCode: "", userCode: "8MXX-2YNT", verificationURL: "https://app.basecamp.com/oauth/device_verification",
        interval: 5, expiresAt: Date().addingTimeInterval(600))
}

/// The Basecamp half of setup 1: what will happen, then the code while Forge waits for the approval.
struct BasecampSignInPanel: View {
    @ObservedObject var signIn: BasecampSignIn
    let openLink: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let code = signIn.code {
                Text("Approve this code in Basecamp").font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
                Text(code.userCode).font(Theme.mono(28, .medium)).foregroundStyle(Theme.heatBright).textSelection(.enabled)
                HStack(spacing: 10) {
                    Spinner(heat: true)
                    Text("Waiting for you to approve it in your browser…").font(Theme.sans(13)).foregroundStyle(Theme.textSec)
                }
                HStack(spacing: 16) {
                    Button("Open the page again") { openLink(code.verificationURL) }.buttonStyle(ForgeButton(kind: .plain))
                    Button("Cancel") { signIn.cancel() }.buttonStyle(ForgeButton(kind: .plain))
                }
                .padding(.top, 4)
            } else {
                Text("Sign in with your browser").font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
                Text(
                    "Forge opens Basecamp and shows a short code. Approve it there and pick the account; "
                        + "Forge acts as you and assigns itself the cards it works on."
                )
                .font(Theme.sans(13)).foregroundStyle(Theme.textSec).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Image(systemName: "lock").font(.system(size: 10))
                    Text("No password here. The sign-in is kept in your Mac's Keychain and nowhere else.")
                }
                .font(Theme.sans(11)).foregroundStyle(Theme.textMuted).padding(.top, 4)
            }
        }
        .padding(20)
        .frame(maxWidth: 640, alignment: .leading)
        .panel()
    }
}

/// Setup 2 on Basecamp: pick the project and its card table, see the pipeline one line per column, and add
/// the columns the card table is missing (only after a yes, since everyone in the project sees them).
struct BasecampProjectScreen: View {
    @ObservedObject var model: AppModel
    @State var projects: [BasecampAPI.Project] = []
    @State private var projectID = 0
    @State private var tableID = 0
    @State private var table: BasecampAPI.CardTable?
    @State private var busy = false
    @State private var problem: String?
    @State private var asking = false
    @State private var notes: [String] = []

    private var project: BasecampAPI.Project? { projects.first { $0.id == projectID } }
    private var existing: [String] { table?.lists.map(\.title) ?? [] }
    private var missing: [Column] { Pipeline.missing(existing: existing) }
    private var ready: Bool { table != nil && missing.isEmpty }

    var body: some View {
        SetupFrame(
            model: model,
            question: "Which project should Forge work on?",
            detail: "Pick the Basecamp project and its card table. Every card moves through these columns:",
            primary: "Continue",
            primaryEnabled: ready,
            busy: busy,
            action: finish
        ) {
            HStack(spacing: 24) {
                Picker("Project", selection: $projectID) {
                    if projectID == 0 { Text("Choose…").tag(0) }
                    ForEach(projects) { Text($0.name).tag($0.id) }
                }
                .fixedSize()
                if let p = project, p.cardTables.count > 1 {
                    Picker("Card table", selection: $tableID) {
                        ForEach(p.cardTables, id: \.id) { Text($0.title ?? "Card Table").tag($0.id) }
                    }
                    .fixedSize()
                }
            }
            .font(Theme.sans(13))
            .foregroundStyle(Theme.textSec)
            .padding(.bottom, 18)
            ColumnList(existing: existing, showMarks: table != nil, where: "Basecamp")
            if table != nil && !missing.isEmpty {
                HStack(spacing: 12) {
                    Text("\(missing.count) column\(missing.count == 1 ? " is" : "s are") missing from this card table.")
                        .font(Theme.sans(13))
                        .foregroundStyle(Theme.heatBright)
                    Button("Add them to Basecamp…") { asking = true }
                        .buttonStyle(ForgeButton(kind: .fix))
                }
                .padding(.top, 14)
            }
            if project != nil && project?.cardTables.isEmpty == true {
                ProblemLine(text: "This project has no card table. Turn on Card Table in the project's tools in Basecamp, then pick it again.")
            }
            ForEach(notes, id: \.self) { GoodLine(text: $0).padding(.top, 6) }
            ProblemLine(text: problem)
        }
        .task { await loadProjects() }
        .onChange(of: projectID) { _, _ in
            tableID = project?.cardTables.first?.id ?? 0
            Task { await loadTable() }
        }
        .onChange(of: tableID) { _, _ in Task { await loadTable() } }
        .confirmationDialog(
            "Add \(missing.count) column\(missing.count == 1 ? "" : "s") to \(project?.name ?? "this project") in Basecamp?",
            isPresented: $asking
        ) {
            Button("Add \(missing.map(\.name).joined(separator: ", "))") { Task { await createMissing() } }
            Button("Not now", role: .cancel) {}
        } message: {
            Text("This changes the project's card table: everyone in the project will see the new columns.")
        }
    }

    private func loadProjects() async {
        if model.preview {
            projects = model.sample.basecampProjects
            projectID = projects.first?.id ?? 0
            table = model.sample.basecampTable
            return
        }
        guard let api = model.basecampAPI else { return }
        busy = true
        defer { busy = false }
        do {
            projects = try await api.projects().sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            if let id = model.choices.basecamp?.projectID.flatMap(Int.init), projects.contains(where: { $0.id == id }) {
                projectID = id
            } else if projects.count == 1 {
                projectID = projects[0].id
            }
        } catch { problem = "\(error)" }
    }

    private func loadTable() async {
        if model.preview {
            table = model.sample.basecampTable
            return
        }
        table = nil
        guard let api = model.basecampAPI, projectID != 0, tableID != 0 else { return }
        busy = true
        defer { busy = false }
        do { table = try await api.cardTable(project: projectID, id: tableID) } catch { problem = "\(error)" }
    }

    private func createMissing() async {
        guard let api = model.basecampAPI else { return }
        busy = true
        defer { busy = false }
        do {
            try await api.createMissing(project: projectID, table: tableID, missing)
            table = try await api.cardTable(project: projectID, id: tableID)
            notes = ["The columns are ready."]
        } catch { problem = "\(error)" }
    }

    private func finish() {
        guard let p = project, let t = table, var b = model.choices.basecamp else { return }
        b.projectID = String(p.id)
        b.projectName = p.name
        b.cardTableID = String(t.id)
        b.columns = BasecampAPI.columnMap(t)
        model.choices.basecamp = b
        model.choices.projectID = String(p.id)
        model.choices.projectName = p.name
        model.choices.projectSlug = String(p.id)
        model.choices.columnsReady = true
        model.next()
    }
}
