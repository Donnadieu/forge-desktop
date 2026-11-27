import SwiftUI

/// The GitHub automations Forge needs off in a project, one row each, marked On or Off, with the page that turns
/// them off and a way to check again. GitHub's Workflows page lists about a dozen; this names exactly which.
struct AutomationsPanel: View {
    let rows: [GitHubProjectsAPI.Automation]
    let checking: Bool
    let checkedAt: Date?
    let open: () -> Void
    let check: () -> Void

    var body: some View {
        Notice(
            title: GitHubProjectScreen.automationsTitle(on: rows.filter(\.on).count),
            detail: GitHubProjectScreen.automationSteps
        ) {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(rows, id: \.name) { row($0) }
                HStack(spacing: 16) {
                    Button("Open Workflows on GitHub ↗", action: open).buttonStyle(ForgeButton(kind: .fix))
                    Button(GitHubProjectScreen.checkAgainTitle, action: check).buttonStyle(ForgeButton(kind: .plain)).disabled(checking)
                    if checking {
                        Spinner()
                    } else if let checkedAt {
                        Text("Checked at \(checkedAt.formatted(date: .omitted, time: .standard))")
                            .font(Theme.sans(.caption)).foregroundStyle(Theme.textMuted)
                    }
                }
                .padding(.top, 6)
                Text(GitHubProjectScreen.stayOnLine)
                    .font(Theme.sans(.caption)).foregroundStyle(Theme.textMuted).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.leading, 36)
        }
    }

    private func row(_ a: GitHubProjectsAPI.Automation) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: a.on ? "circle.fill" : "checkmark.circle.fill")
                .font(Theme.icon(.caption))
                .foregroundStyle(a.on ? Theme.heatBright : Theme.good)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(a.name).font(Theme.sans(.body, .medium)).foregroundStyle(a.on ? Theme.text : Theme.textSec)
                    Text(a.on ? "On" : "Off").font(Theme.mono(.label)).foregroundStyle(a.on ? Theme.heatBright : Theme.good)
                }
                if a.on {
                    Text("It \(a.why).").font(Theme.sans(.caption)).foregroundStyle(Theme.textSec).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}
