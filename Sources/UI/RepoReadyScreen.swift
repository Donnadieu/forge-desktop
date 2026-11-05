import SwiftUI

/// Setup 6, harness engineering: get the repo ready for agents. An agent reads the whole repo (read-only) and
/// proposes guardrails; the person picks them, and Forge makes one card that builds them as a pull request
/// through the pipeline. Opened from Settings, it also shows where the repo stands, ticks off the guardrails
/// that landed, and lets the person pick only what's left.
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
    private var record: HarnessRecord { model.choices.harnessHere }
    private var changing: Bool { model.changing }
    /// Opened from Settings with nothing left to pick: every proposed guardrail landed or waits in a card.
    private var nothingLeft: Bool { changing && report != nil && record.left.isEmpty }

    var body: some View {
        SetupFrame(
            model: model,
            question: "Get \(repo) ready for agents",
            detail: detail,
            primary: report == nil ? "Read my repo" : (nothingLeft ? "Read it again" : "Make the card"),
            primaryEnabled: report == nil || nothingLeft || !chosen.isEmpty,
            busy: busy,
            action: report == nil || nothingLeft ? read : makeCard,
            secondary: secondary
        ) {
            if let offer = model.harnessOffer {
                Notice(title: "You switched to \(offer).", detail: "Get it ready for agents now, or come back to it from Settings.")
                    .frame(maxWidth: 680)
                    .padding(.bottom, 16)
            } else if changing {
                HarnessStatusPanel(record: record, repo: repo) { model.openLink($0) }
                    .padding(.bottom, 20)
            }
            if reading, let started {
                ReadingPanel(repo: repo, started: started, cancel: cancelRead)
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
            if let r = report, !reading {
                ReportView(
                    report: r, chosen: $chosen, record: changing ? record : HarnessRecord(), findings: !changing || (record.applied ?? []).isEmpty)
            }
            ProblemLine(text: problem)
        }
        .onAppear(perform: restore)
        .task { if changing { await model.refreshHarness() } }
        .onChange(of: record) { _, r in chosen.formIntersection(r.left.map(\.id)) }
    }

    private var detail: String {
        if report == nil {
            return "Your agent reads the whole repo, changes nothing, and tells you how ready it is and which guardrails would help: "
                + "a formatter, a linter, rules that stop common mistakes. You pick, and Forge makes one card that adds them as a pull request."
        }
        if nothingLeft { return "Every guardrail it proposed is in place or in a card. Read the repo again to see if anything new would help." }
        if changing, record.left.count < report?.guardrails.count ?? 0 {
            return "Guardrails already in place are ticked off. Pick from the rest; Forge makes one card for them."
        }
        return "Here's what your agent found. Pick the guardrails to add; Forge makes one card, and the result comes back to you in Human Review."
    }

    /// The quieter choice: Skip on the first run; Not now after a repo change; Read it again when changing.
    private var secondary: (title: String, action: () -> Void)? {
        if !changing { return ("Skip for now", skip) }
        if model.harnessOffer != nil, report == nil { return ("Not now", { model.go(AppModel.settingsScreen) }) }
        if report != nil, !nothingLeft { return ("Read it again", read) }
        return nil
    }

    private func restore() {
        if model.preview {
            if model.choices.repoReadyCard == "show-report" || record.proposed != nil { use(model.sample.report) }
            if model.sample.scene == "reading" {
                reading = true
                started = Date().addingTimeInterval(-72)
            }
            return
        }
        if let r = RepoReader.saved(for: repo) {
            use(r)
        } else if changing, let proposed = record.proposed, !proposed.isEmpty {
            use(RepoReader.Report(summary: [], guardrails: proposed))
        }
    }

    private func use(_ r: RepoReader.Report) {
        report = r
        let open = changing ? Set(record.left.map(\.id)) : Set(r.guardrails.map(\.id))
        chosen = Set(r.guardrails.filter { $0.recommended != false && open.contains($0.id) }.map(\.id))
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
                if Task.isCancelled { return }
                var h = record
                h.read(r.guardrails)
                model.choices.setHarness(h, for: repo)
                model.save(restarts: false)
                use(r)
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
        let picked = r.guardrails.filter { chosen.contains($0.id) && (!changing || record.item($0.id) == .open) }
        busy = true
        problem = nil
        Task {
            defer { busy = false }
            if !model.preview {
                do {
                    let card = try await model.makeCard(title: "Get \(repo) ready for agents", description: RepoReader.cardText(r, chosen: picked))
                    model.choices.repoReadyCard = card.url
                    var h = record
                    if h.proposed == nil { h.read(r.guardrails) }
                    h.sent(card: card.identifier, url: card.url, picked: picked.map(\.id))
                    model.choices.setHarness(h, for: repo)
                } catch {
                    problem = "\(error)"
                    return
                }
            }
            model.choices.repoReady = true
            model.next(restarts: false)
        }
    }

    private func skip() {
        model.choices.repoReady = true
        model.next()
    }
}

/// The read in progress: an estimate, the time so far, and Cancel, in one panel.
struct ReadingPanel: View {
    let repo: String
    let started: Date
    let cancel: () -> Void

    var body: some View {
        TimelineView(.periodic(from: started, by: 1)) { ctx in
            let s = Int(ctx.date.timeIntervalSince(started))
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 12) {
                    Spinner(heat: true)
                    Text("Reading \(repo)…").font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
                    Spacer()
                    Button("Cancel", action: cancel).buttonStyle(ForgeButton(kind: .ghost))
                }
                Text("Usually a few minutes · \(s / 60):\(String(format: "%02d", s % 60)) so far")
                    .font(Theme.mono(11)).foregroundStyle(Theme.textMuted).padding(.leading, 24)
            }
            .padding(20)
            .frame(maxWidth: 640)
            .panel(live: true)
        }
    }
}
