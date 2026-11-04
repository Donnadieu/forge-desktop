import SwiftUI

/// Setup 2: pick the team and project from lists, see the pipeline one line per column, and create the
/// columns the team is missing (only after a yes, since it changes the person's Linear).
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
    private var ready: Bool { !projectID.isEmpty && !existing.isEmpty && missing.isEmpty }

    var body: some View {
        SetupFrame(
            model: model,
            question: "Which project should Forge work on?",
            detail: "Pick the Linear team and project. Every card moves through these columns:",
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
                Picker("Project", selection: $projectID) {
                    if projectID.isEmpty { Text("Choose…").tag("") }
                    ForEach(projects) { Text($0.name).tag($0.id) }
                }
                .fixedSize()
                .disabled(teamID.isEmpty)
            }
            .font(Theme.sans(13))
            .foregroundStyle(Theme.textSec)
            .padding(.bottom, 18)
            ColumnList(existing: existing, showMarks: !teamID.isEmpty)
            if !teamID.isEmpty && !missing.isEmpty && !existing.isEmpty {
                HStack(spacing: 12) {
                    Text("\(missing.count) column\(missing.count == 1 ? " is" : "s are") missing from this team.")
                        .font(Theme.sans(13))
                        .foregroundStyle(Theme.heatBright)
                    Button("Add them to Linear…") { asking = true }
                        .buttonStyle(ForgeButton(kind: .fix))
                }
                .padding(.top, 14)
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
            if let pid = model.choices.projectID, projects.contains(where: { $0.id == pid }) {
                projectID = pid
            } else {
                projectID = projects.count == 1 ? projects[0].id : ""
            }
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
        guard let p = projects.first(where: { $0.id == projectID }) else { return }
        model.choices.teamID = teamID
        model.choices.teamName = teamName
        model.choices.projectID = p.id
        model.choices.projectName = p.name
        model.choices.projectSlug = p.slugId
        model.choices.columnsReady = true
        model.next()
    }
}

/// The ten columns with one plain line each, and whether the team has each one.
struct ColumnList: View {
    let existing: [String]
    let showMarks: Bool

    var body: some View {
        let have = Set(existing.map(Pipeline.normalized))
        VStack(spacing: 0) {
            ForEach(Array(Pipeline.columns.enumerated()), id: \.element.name) { i, c in
                if i > 0 { Rectangle().fill(Theme.border).frame(height: 1) }
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    StageDot(stage: c.name).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                    Text(c.name)
                        .font(Theme.sans(13, .semibold))
                        .foregroundStyle(Theme.text)
                        .frame(width: 108, alignment: .leading)
                    Text(c.line)
                        .font(Theme.sans(13))
                        .foregroundStyle(Theme.textSec)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    if showMarks {
                        let ok = have.contains(Pipeline.normalized(c.name))
                        Chip(text: ok ? "In Linear" : "Missing", tone: ok ? .quiet : .heat)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
            }
        }
        .panel()
    }
}
