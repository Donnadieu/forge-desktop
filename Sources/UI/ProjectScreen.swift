import SwiftUI

/// Setup 2: pick the team (and, if wanted, one project) from lists, see the pipeline one line per column, and
/// create the columns the team is missing (only after a yes, since it changes the person's Linear).
struct ProjectScreen: View {
    @ObservedObject var model: AppModel
    @State var teams: [LinearAPI.Team] = []
    @State var projects: [LinearAPI.Project] = []
    @State var existing: [String] = []
    @State private var teamID = ""
    @State private var projectID = ""
    @State private var busy = false
    @State private var problem: String?
    @State private var asking = false
    @State private var notes: [String] = []

    private var missing: [Column] { Pipeline.missing(existing: existing) }
    private var ready: Bool { Self.canContinue(team: teamID, existing: existing) }

    /// The team is enough: a project only narrows the cards. The team needs only the required columns;
    /// the optional ones it lacks just don't run.
    static func canContinue(team: String, existing: [String]) -> Bool {
        !team.isEmpty && !existing.isEmpty && Pipeline.missingRequired(existing: existing).isEmpty
    }

    var body: some View {
        SetupFrame(
            model: model,
            question: "Which team should Forge work on?",
            detail: "Pick the Linear team. Every card moves through these columns:",
            primary: "Continue",
            primaryEnabled: ready,
            busy: busy,
            action: finish
        ) {
            HStack(spacing: 24) {
                Picker("Team", selection: $teamID) {
                    if teamID.isEmpty { Text("Choose…").tag("") }
                    ForEach(teams) { Text($0.name).tag($0.id) }
                }
                .fixedSize()
                Picker("Project (optional)", selection: $projectID) {
                    Text("All projects").tag("")
                    ForEach(projects) { Text($0.name).tag($0.id) }
                }
                .fixedSize()
                .disabled(teamID.isEmpty)
            }
            .font(Theme.sans(.body))
            .foregroundStyle(Theme.textSec)
            .padding(.bottom, 6)
            Text("Only pick up cards from one project. With none, Forge works on all of \(teamName)'s cards.")
                .font(Theme.sans(.small))
                .foregroundStyle(Theme.textSec)
                .padding(.bottom, 18)
            ColumnList(existing: existing, showMarks: !teamID.isEmpty)
            if !teamID.isEmpty && !existing.isEmpty {
                MissingColumnsNote(existing: existing, from: "this team", tracker: "Linear") { asking = true }
            }
            ForEach(notes, id: \.self) { GoodLine(text: $0).padding(.top, 6) }
            ProblemLine(text: problem)
        }
        .task { await loadTeams() }
        .onChange(of: teamID) { _, t in Task { await loadTeam(t) } }
        .confirmationDialog(
            "Add \(missing.count) column\(missing.count == 1 ? "" : "s") to \(teamName) in Linear?",
            isPresented: $asking
        ) {
            Button("Add \(missing.map(\.name).joined(separator: ", "))") { Task { await createMissing() } }
            Button("Not now", role: .cancel) {}
        } message: {
            Text("This changes your Linear team: everyone on it will see the new columns.")
        }
    }

    private var teamName: String { teams.first { $0.id == teamID }?.name ?? "this team" }

    private func loadTeams() async {
        if model.preview {
            teams = model.sample.teams
            if model.sample.scene == "shared-board" { teams = [LinearAPI.Team(id: "t1", name: "ATC Rewrite", key: "ATC", triageEnabled: true)] }
            teamID = teams[0].id
            return
        }
        guard let api = model.linear else { return }
        busy = true
        defer { busy = false }
        do {
            teams = try await api.teams()
            if let t = model.choices.teamID, teams.contains(where: { $0.id == t }) {
                teamID = t
            } else if teams.count == 1 {
                teamID = teams[0].id
            }
        } catch { problem = "\(error)" }
    }

    private func loadTeam(_ id: String) async {
        if model.preview {
            projects = model.sample.projects
            existing = model.sample.states
            projectID = projects[0].id
            if model.sample.scene == "team-no-project" { (existing, projectID) = (Pipeline.names, "") }
            if model.sample.scene == "shared-board" { (existing, projectID) = (["Backlog", "Triage", "Todo", "In Progress", "Done"], "") }
            return
        }
        guard !id.isEmpty, let api = model.linear else { return }
        busy = true
        defer { busy = false }
        do {
            async let p = api.projects(team: id)
            async let s = api.states(team: id)
            projects = try await p
            existing = try await s.map(\.name)
            let saved = model.choices.projectID
            projectID = saved.flatMap { pid in projects.contains(where: { $0.id == pid }) ? pid : nil } ?? ""
        } catch { problem = "\(error)" }
    }

    private func createMissing() async {
        guard let api = model.linear else { return }
        busy = true
        defer { busy = false }
        do {
            notes = try await api.createMissing(team: teamID, missing)
            notes.append("The columns are ready.")
            existing = try await api.states(team: teamID).map(\.name)
        } catch { problem = "\(error)" }
    }

    private func finish() {
        guard Self.canContinue(team: teamID, existing: existing) else { return }
        let p = projects.first(where: { $0.id == projectID })
        model.choices.teamID = teamID
        model.choices.teamName = teamName
        model.choices.projectID = p?.id
        model.choices.projectName = p?.name ?? teamName
        model.choices.projectSlug = p?.slugId
        model.choices.columnsReady = true
        model.choices.boardColumns = existing
        model.next()
    }
}

/// The ten columns with one plain line each, and whether the team (or card table) has each one.
struct ColumnList: View {
    let existing: [String]
    let showMarks: Bool
    /// Where the columns live, for the marks ("In Linear").
    var `where` = "Linear"

    var body: some View {
        let have = Set(existing.map(Pipeline.normalized))
        VStack(spacing: 0) {
            ForEach(Array(Pipeline.columns.enumerated()), id: \.element.name) { i, c in
                if i > 0 { Rectangle().fill(Theme.border).frame(height: 1) }
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    StageDot(stage: c.name).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                    Text(c.name)
                        .font(Theme.sans(.body, .semibold))
                        .foregroundStyle(Theme.text)
                        .frame(width: 108, alignment: .leading)
                    Text(c.line)
                        .font(Theme.sans(.body))
                        .foregroundStyle(Theme.textSec)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    if showMarks {
                        let ok = have.contains(Pipeline.normalized(c.name))
                        Chip(text: ok ? "In \(`where`)" : "Missing", tone: ok ? .quiet : .heat)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
            }
        }
        .panel()
    }
}

/// Under the column list: which columns are missing, the offer to add them (only on a tap, it asks first), and
/// one plain line saying what Forge will and won't do without them.
struct MissingColumnsNote: View {
    let existing: [String]
    /// "this team", "this card table", "this project's Status".
    let from: String
    let tracker: String
    let add: () -> Void

    var body: some View {
        let missing = Pipeline.missing(existing: existing)
        let required = Pipeline.missingRequired(existing: existing)
        if !missing.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 12) {
                    Text("\(missing.count) column\(missing.count == 1 ? " is" : "s are") missing from \(from).")
                        .font(Theme.sans(.body))
                        .foregroundStyle(required.isEmpty ? Theme.textSec : Theme.heatBright)
                    Button("Add them to \(tracker)…", action: add)
                        .buttonStyle(ForgeButton(kind: required.isEmpty ? .secondary : .fix))
                }
                if !required.isEmpty {
                    Text("Forge needs \(Pipeline.listed(required.map(\.name))) to start: there's nowhere to pick up or finish cards without them.")
                        .font(Theme.sans(.body))
                        .foregroundStyle(Theme.heatBright)
                        .fixedSize(horizontal: false, vertical: true)
                } else if let line = Pipeline.withoutLine(existing: existing) {
                    Text(line)
                        .font(Theme.sans(.body))
                        .foregroundStyle(Theme.textSec)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.top, 14)
        }
    }
}
