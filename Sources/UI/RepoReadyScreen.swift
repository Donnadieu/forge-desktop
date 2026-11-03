import SwiftUI

/// Setup 6: get the repo ready for agents. An agent reads the whole repo (read-only) and proposes guardrails;
/// the person picks them, and Forge makes one card that builds them as a pull request through the pipeline.
struct RepoReadyScreen: View {
    @ObservedObject var model: AppModel
    @State private var report: RepoReader.Report?
    @State private var chosen: Set<String> = []
    @State private var busy = false
    @State private var reading = false
    @State private var started: Date?
    @State private var problem: String?

    private var repo: String { model.choices.repo ?? "your repo" }

    var body: some View {
        SetupFrame(
            model: model,
            question: "Get \(repo) ready for agents",
            detail: report == nil
                ? "Your agent reads the whole repo, changes nothing, and tells you how ready it is and which guardrails would help: "
                    + "a formatter, a linter, rules that stop common mistakes. You pick, and Forge makes one card that adds them as a pull request."
                : "Here's what your agent found. Pick the guardrails to add; Forge makes one card, and the result comes back to you in Human Review.",
            primary: report == nil ? "Read my repo" : "Make the card",
            primaryEnabled: report == nil || !chosen.isEmpty,
            busy: busy,
            action: report == nil ? read : makeCard,
            secondary: ("Skip for now", skip)
        ) {
            if reading, let started {
                TimelineView(.periodic(from: started, by: 1)) { ctx in
                    Text(
                        "Reading \(repo)… \(Int(ctx.date.timeIntervalSince(started)) / 60) min \(Int(ctx.date.timeIntervalSince(started)) % 60) s. This can take several minutes."
                    )
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                }
            }
            if let r = report { ReportView(report: r, chosen: $chosen) }
            ProblemLine(text: problem)
        }
        .onAppear(perform: restore)
    }

    private func restore() {
        if model.preview {
            if model.choices.repoReadyCard == "show-report" { use(model.sample.report) }
            return
        }
        if let r = RepoReader.saved(for: repo) { use(r) }
    }

    private func use(_ r: RepoReader.Report) {
        report = r
        chosen = Set(r.guardrails.filter { $0.recommended != false }.map(\.id))
    }

    private func read() {
        busy = true
        reading = true
        started = Date()
        problem = nil
        Task {
            defer {
                busy = false
                reading = false
            }
            if model.preview {
                use(model.sample.report)
                return
            }
            do { use(try await RepoReader.read(model.choices)) } catch { problem = "\(error)" }
        }
    }

    private func makeCard() {
        guard let r = report else { return }
        let picked = r.guardrails.filter { chosen.contains($0.id) }
        busy = true
        problem = nil
        Task {
            defer { busy = false }
            if !model.preview {
                guard let api = model.linear, let team = model.choices.teamID, let project = model.choices.projectID else {
                    problem = "Forge lost track of your Linear project. Go back to the Project screen."
                    return
                }
                do {
                    let card = try await api.createIssue(
                        team: team, project: project, column: "Todo", title: "Get \(repo) ready for agents",
                        description: RepoReader.cardText(r, chosen: picked))
                    model.choices.repoReadyCard = card.url
                } catch {
                    problem = "\(error)"
                    return
                }
            }
            model.choices.repoReady = true
            model.next()
        }
    }

    private func skip() {
        model.choices.repoReady = true
        model.next()
    }
}

/// The assessment in short lines, then the guardrails to tick.
struct ReportView: View {
    let report: RepoReader.Report
    @Binding var chosen: Set<String>

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(report.summary, id: \.self) { Text($0).font(.system(size: 13)) }
                if let m = report.missing, !m.isEmpty {
                    Text("Missing: " + m.joined(separator: " · ")).font(.system(size: 12)).foregroundStyle(.secondary).padding(.top, 4)
                }
                Text("Guardrails").font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary).padding(.top, 12)
                ForEach(report.guardrails) { g in
                    Toggle(isOn: binding(g.id)) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(g.title).font(.system(size: 13, weight: .medium))
                            Text(g.why).font(.system(size: 12)).foregroundStyle(.secondary)
                        }
                    }
                    .toggleStyle(.checkbox)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 400)
    }

    private func binding(_ id: String) -> Binding<Bool> {
        Binding(get: { chosen.contains(id) }, set: { on in if on { chosen.insert(id) } else { chosen.remove(id) } })
    }
}
