import SwiftUI

/// Workflow Studio's "Edit workflow file" (Direction A, Nov 9): the real WORKFLOW.md of the project on screen in
/// an editor. Forge checks it as it's typed (the engine's own rules, plus settings that Workflow Studio or Settings
/// own) and never saves a file with a problem. Saved versions can be put back; saving restarts the engine.
struct WorkflowFileScreen: View {
    @ObservedObject var model: AppModel
    @State private var text = ""
    @State private var saved = ""
    @State private var problems: [WorkflowCheck.Problem] = []
    @State private var checking = false
    @State private var jump: Int?
    @State private var notice: String?
    @State private var restarting = false
    @State private var versions: [(date: Date, url: URL)] = []
    @State private var checkTask: Task<Void, Never>?

    private var file: WorkflowFile { WorkflowFile(home: model.link.host.home) }
    /// The file the app would write for these answers: Forge's own, and what settings it owns.
    private var app: String? { try? EngineSettings.workflowText(model.choices, home: model.link.host.home, store: model.store) }
    private var dirty: Bool { text != saved }

    var body: some View {
        VStack(spacing: 0) {
            TopBar(suffix: "Workflow Studio")
            HStack(alignment: .top, spacing: 40) {
                VStack(alignment: .leading, spacing: 0) {
                    PageHeader(
                        eyebrow: "Forge · Workflow Studio · Workflow file", title: "Workflow file",
                        lead:
                            "The file the engine reads for \(model.choices.projectName ?? "this project"). Edit anything; Forge checks it before it saves."
                    )
                    if let notice { Notice(title: notice).padding(.bottom, 16) }
                    CodeEditor(text: $text, marked: Set(problems.map(\.line)), jump: $jump)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.rLg))
                        .overlay(RoundedRectangle(cornerRadius: Theme.rLg).stroke(Theme.border))
                        .frame(maxHeight: .infinity)
                }
                .frame(maxWidth: .infinity)
                side.frame(width: 320)
            }
            .padding(.horizontal, 40).padding(.top, 32).padding(.bottom, 24)
            bar
        }
        .background(Atmosphere())
        .onAppear(perform: load)
        .onChange(of: text) { _ in scheduleCheck() }
    }

    // MARK: Side panel

    private var side: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel(text: "Check")
            if checking {
                HStack(spacing: 8) {
                    Spinner(heat: true)
                    Text("Checking…").font(Theme.sans(13)).foregroundStyle(Theme.textSec)
                }
            } else if problems.isEmpty {
                HStack(spacing: 8) {
                    Circle().fill(Theme.good).frame(width: 8, height: 8)
                    Text("Looks good. \(text.components(separatedBy: "\n").count) lines.").font(Theme.sans(13)).foregroundStyle(Theme.text)
                }
            } else {
                HStack(alignment: .top, spacing: 8) {
                    Circle().fill(Theme.bad).frame(width: 8, height: 8).padding(.top, 5)
                    Text(
                        "\(problems.count) problem\(problems.count == 1 ? "" : "s"). Nothing is saved until \(problems.count == 1 ? "it's" : "they're") fixed."
                    )
                    .font(Theme.sans(13, .medium)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
                }
                ForEach(Array(problems.enumerated()), id: \.offset) { _, p in
                    Button {
                        jump = p.line
                    } label: {
                        Text("Line \(p.line) · \(p.message)").font(Theme.sans(12)).foregroundStyle(Theme.silver)
                            .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(10)
                            .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(Theme.badWash))
                            .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.badBorder))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            Rectangle().fill(Theme.border).frame(height: 1).padding(.vertical, 4)
            SectionLabel(text: "Studio changes only")
            Text("Its switches rewrite these settings and the app's marked part, nothing else, so your edits stay.")
                .font(Theme.sans(11)).foregroundStyle(Theme.textMuted).fixedSize(horizontal: false, vertical: true)
            FlowChipsRow(values: ["active_states", "promote", "roles", "max_concurrent_agents", "marks"])
            Rectangle().fill(Theme.border).frame(height: 1).padding(.vertical, 4)
            SectionLabel(text: "Saved versions")
            versionRow("Now", current: true, put: nil)
            ForEach(Array(versions.prefix(4).enumerated()), id: \.offset) { _, v in
                versionRow(Self.when(v.date), current: false) { putBack(v) }
            }
            versionRow("Forge's own file", current: false) { startOver() }
        }
        .padding(20)
        .panel()
    }

    private func versionRow(_ title: String, current: Bool, put: (() -> Void)?) -> some View {
        HStack {
            Text(title).font(Theme.mono(12)).foregroundStyle(current ? Theme.text : Theme.textSec)
            Spacer()
            if current {
                Chip(text: "current", tone: .quiet)
            } else if let put {
                Button("Put back", action: put).buttonStyle(ForgeButton(kind: .ghost)).disabled(restarting)
            }
        }
    }

    // MARK: Bottom bar

    private var bar: some View {
        BottomBar {
            HStack(spacing: 8) {
                if restarting {
                    Spinner(heat: true)
                    Text("Saved. Restarting the engine…").foregroundStyle(Theme.textSec)
                } else {
                    if dirty {
                        Text("Edited · not saved").font(Theme.mono(11)).foregroundStyle(Theme.text)
                        Text("·")
                    }
                    Text(problems.isEmpty ? "Saving restarts the engine." : "Fix \(problems.count) problem\(problems.count == 1 ? "" : "s") to save.")
                }
            }
        } actions: {
            Button("Back to Workflow Studio") { model.go(AppModel.workflowScreen) }
                .buttonStyle(ForgeButton(kind: .ghost, icon: "chevron.left", large: true)).disabled(restarting)
            Button("Undo last save") { if let v = versions.first { putBack(v) } }
                .buttonStyle(ForgeButton(kind: .ghost, large: true)).disabled(versions.isEmpty || restarting)
            Button("Save file", action: save)
                .buttonStyle(ForgeButton(kind: .primary, large: true))
                .disabled(!dirty || !problems.isEmpty || checking || restarting)
        }
    }

    // MARK: Actions

    private func load() {
        if model.preview {
            let sample = app ?? "---\n---\n"
            (text, saved, versions) = (
                sample, sample,
                [(Date().addingTimeInterval(-1680), URL(fileURLWithPath: "/v1")), (Date().addingTimeInterval(-86_400), URL(fileURLWithPath: "/v2"))]
            )
            switch model.sample.scene {
            case "file-problems":
                text = sample.replacingOccurrences(of: "  max_turns: 20", with: "  max_turn: 20").replacingOccurrences(
                    of: "  interval_ms: 30000", with: "\tinterval_ms: 30000")
                let lines = text.components(separatedBy: "\n")
                let line = { (s: String) in (lines.firstIndex { $0.contains(s) } ?? 0) + 1 }
                problems = [
                    .init(line: line("max_turn:"), message: "max_turn isn't a setting Forge knows. Did you mean max_turns?"),
                    .init(line: line("\tinterval_ms"), message: "This line is indented with a tab. The settings block needs spaces."),
                ]
                jump = problems.first?.line
            case "file-undo":
                text = sample.replacingOccurrences(of: "  max_turns: 20", with: "  max_turns: 30")
                notice = "Put back the version from \(Self.when(versions[0].date)). Save to use it."
            default: break
            }
            return
        }
        let current = file.text ?? app ?? ""
        (text, saved, versions) = (current, current, file.versions())
        scheduleCheck()
    }

    private func scheduleCheck() {
        guard !model.preview else { return }
        checkTask?.cancel()
        checking = true
        let snapshot = text
        let appText = app
        checkTask = Task {
            try? await Task.sleep(nanoseconds: 600_000_000)
            guard !Task.isCancelled else { return }
            let found = await WorkflowCheck.all(snapshot, app: appText)
            guard !Task.isCancelled, snapshot == text else { return }
            problems = found
            checking = false
        }
    }

    private func putBack(_ v: (date: Date, url: URL)) {
        guard let old = try? String(contentsOf: v.url, encoding: .utf8) else { return }
        text = old
        notice = "Put back the version from \(Self.when(v.date)). Save to use it."
    }

    private func startOver() {
        guard let app else { return }
        text = app
        notice = "This is the file Forge writes. Save to use it; Forge then manages the whole file again."
    }

    private func save() {
        let new = text
        let appText = app
        restarting = true
        Task {
            let found = await WorkflowCheck.all(new, app: appText)
            guard found.isEmpty else {
                problems = found
                restarting = false
                return
            }
            do {
                try file.save(new, edited: new != appText)
            } catch {
                problems = [.init(line: 1, message: "Forge couldn't write the file: \(error.localizedDescription)")]
                restarting = false
                return
            }
            if let w = model.workspace?.id { await model.restartEngines(in: w) }
            restarting = false
            model.go(AppModel.boardScreen)
        }
    }

    static func when(_ d: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = Calendar.current.isDateInToday(d) ? "'Today' HH:mm" : "MMM d HH:mm"
        return f.string(from: d)
    }
}

/// Mono chips that wrap onto as many lines as they need (the side panel's 280 points).
struct FlowChipsRow: View {
    let values: [String]

    var body: some View {
        var rows: [[String]] = [[]]
        var width: CGFloat = 0
        for v in values {
            let w = CGFloat(v.count) * 6.6 + 24
            if width + w > 270, !rows[rows.count - 1].isEmpty {
                rows.append([])
                width = 0
            }
            rows[rows.count - 1].append(v)
            width += w
        }
        return VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 8) { ForEach(row, id: \.self) { Chip(text: $0) } }
            }
        }
    }
}
