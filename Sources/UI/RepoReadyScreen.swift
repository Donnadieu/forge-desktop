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
    @State private var readTask: Task<Void, Never>?

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
                    let s = Int(ctx.date.timeIntervalSince(started))
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 12) {
                            Spinner(heat: true)
                            Text("Reading \(repo)…").font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
                            Spacer()
                            Button("Cancel", action: cancelRead).buttonStyle(ForgeButton(kind: .ghost))
                        }
                        Text("Usually a few minutes · \(s / 60):\(String(format: "%02d", s % 60)) so far")
                            .font(Theme.mono(11)).foregroundStyle(Theme.textMuted).padding(.leading, 24)
                    }
                    .padding(20)
                    .frame(maxWidth: 640)
                    .panel(live: true)
                }
            } else if report == nil {
                VStack(alignment: .leading, spacing: 10) {
                    SectionLabel(text: "Your agent reads")
                    ForEach(["How to build, test and run it", "Which checks and agent docs it already has", "The risky areas"], id: \.self) {
                        line in
                        HStack(spacing: 10) {
                            Circle().fill(Theme.heat).frame(width: 5, height: 5)
                            Text(line).font(Theme.sans(14)).foregroundStyle(Theme.textSec)
                        }
                    }
                }
                .padding(16)
                .frame(maxWidth: 640, alignment: .leading)
                .panel()
            }
            if let r = report { ReportView(report: r, chosen: $chosen) }
            ProblemLine(text: problem)
        }
        .onAppear(perform: restore)
    }

    private func restore() {
        if model.preview {
            if model.choices.repoReadyCard == "show-report" { use(model.sample.report) }
            if model.sample.scene == "reading" {
                reading = true
                started = Date().addingTimeInterval(-72)
            }
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
        readTask = Task {
            defer {
                busy = false
                reading = false
            }
            if model.preview {
                use(model.sample.report)
                return
            }
            do {
                let r = try await RepoReader.read(model.choices)
                if !Task.isCancelled { use(r) }
            } catch {
                if !Task.isCancelled { problem = "\(error)" }
            }
        }
    }

    /// Stops the read: the agent is stopped and nothing is saved.
    private func cancelRead() {
        readTask?.cancel()
        readTask = nil
        busy = false
        reading = false
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
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(report.summary, id: \.self) { line in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Circle().fill(Theme.textMuted).frame(width: 4, height: 4).alignmentGuide(.firstTextBaseline) { $0[.bottom] + 4 }
                        Text(line).font(Theme.sans(14)).foregroundStyle(Theme.text)
                    }
                }
                if let m = report.missing, !m.isEmpty {
                    HStack(spacing: 6) {
                        Text("Missing").font(Theme.sans(12)).foregroundStyle(Theme.textMuted).padding(.trailing, 4)
                        ForEach(m, id: \.self) { Chip(text: $0, tone: .warn) }
                    }
                    .padding(.top, 6)
                }
                SectionLabel(text: "Guardrails").padding(.top, 18)
                VStack(spacing: 0) {
                    ForEach(Array(report.guardrails.enumerated()), id: \.element.id) { i, g in
                        if i > 0 { Rectangle().fill(Theme.border).frame(height: 1) }
                        CheckRow(on: binding(g.id)) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(g.title).font(Theme.sans(14, .medium)).foregroundStyle(Theme.text)
                                Text(g.why).font(Theme.sans(12)).foregroundStyle(Theme.textSec)
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                    }
                }
                .panel()
            }
            .frame(maxWidth: 680, alignment: .leading)
        }
    }

    private func binding(_ id: String) -> Binding<Bool> {
        Binding(get: { chosen.contains(id) }, set: { on in if on { chosen.insert(id) } else { chosen.remove(id) } })
    }
}
