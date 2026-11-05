import SwiftUI

/// The mark at the end of a step row and on the Harness engineering tile: a check when done, a half-filled
/// circle when partly done, an empty red circle when not done (`tick` = the first run's quiet check).
struct HarnessMark: View {
    let badge: StepRow.Badge

    var body: some View {
        switch badge {
        case .none: EmptyView()
        case .tick:
            Image(systemName: "checkmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.textMuted)
        case .check:
            Image(systemName: "checkmark.circle.fill").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.good)
        case .half:
            Image(systemName: "circle.lefthalf.filled").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.heat)
        case .notDone:
            Circle().stroke(Theme.bad, lineWidth: 1.5).frame(width: 11, height: 11).frame(width: 13, height: 13)
        }
    }

    static func of(_ status: HarnessRecord.Status) -> StepRow.Badge {
        switch status {
        case .done: return .check
        case .partly: return .half
        case .notStarted: return .notDone
        }
    }
}

/// Where the repo stands: the mark and status, one line on the guardrails, and the card and pull request.
struct HarnessStatusPanel: View {
    let record: HarnessRecord
    let repo: String
    var openCard: ((String) -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            HarnessMark(badge: HarnessMark.of(record.status)).padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                Text("\(record.status.rawValue) · \(repo)").font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
                Text(record.line).font(Theme.sans(12)).foregroundStyle(Theme.textSec)
                if record.prLine != nil || record.cardURL != nil {
                    HStack(spacing: 12) {
                        if let pr = record.prLine { Text(pr).font(Theme.mono(11)).foregroundStyle(Theme.textMuted) }
                        if let url = record.cardURL, let card = record.card, let openCard {
                            Button("Open \(card) in \(url.contains("basecamp") ? "Basecamp" : "Linear")") { openCard(url) }.buttonStyle(
                                ForgeButton(kind: .plain))
                        }
                    }
                    .padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: 680, alignment: .leading)
        .panel()
    }
}

/// The assessment in short lines, then the guardrails to tick. Guardrails that already landed, or wait in an
/// open card, are shown but can't be ticked again.
struct ReportView: View {
    let report: RepoReader.Report
    @Binding var chosen: Set<String>
    var record = HarnessRecord()
    /// The read's findings (summary and what's missing); hidden once guardrails landed, since they're out of date.
    var findings = true

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(findings ? report.summary : [], id: \.self) { line in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Circle().fill(Theme.textMuted).frame(width: 4, height: 4).alignmentGuide(.firstTextBaseline) { $0[.bottom] + 4 }
                        Text(line).font(Theme.sans(14)).foregroundStyle(Theme.text)
                    }
                }
                if findings, let m = report.missing, !m.isEmpty {
                    HStack(spacing: 6) {
                        Text("Missing").font(Theme.sans(12)).foregroundStyle(Theme.textMuted).padding(.trailing, 4)
                        ForEach(m, id: \.self) { Chip(text: $0, tone: .warn) }
                    }
                    .padding(.top, 6)
                }
                SectionLabel(text: "Guardrails").padding(.top, findings && !report.summary.isEmpty ? 18 : 0)
                VStack(spacing: 0) {
                    ForEach(Array(report.guardrails.enumerated()), id: \.element.id) { i, g in
                        if i > 0 { Rectangle().fill(Theme.border).frame(height: 1) }
                        row(g).padding(.horizontal, 14).padding(.vertical, 10)
                    }
                }
                .panel()
            }
            .frame(maxWidth: 680, alignment: .leading)
        }
    }

    @ViewBuilder private func row(_ g: RepoReader.Guardrail) -> some View {
        let item = record.item(g.id)
        if item == .open {
            CheckRow(on: binding(g.id)) { words(g, dim: false) }
        } else {
            HStack(alignment: .top, spacing: 12) {
                HarnessMark(badge: item == .done ? .check : .half).frame(width: 16, height: 16).padding(.top, 1)
                words(g, dim: true)
                Spacer(minLength: 8)
                if item == .done {
                    Chip(text: "Done", tone: .good)
                } else {
                    Chip(text: "In \(record.card ?? "a card")", tone: .heat)
                }
            }
        }
    }

    private func words(_ g: RepoReader.Guardrail, dim: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(g.title).font(Theme.sans(14, .medium)).foregroundStyle(dim ? Theme.textSec : Theme.text)
            Text(g.why).font(Theme.sans(12)).foregroundStyle(dim ? Theme.textMuted : Theme.textSec)
        }
    }

    private func binding(_ id: String) -> Binding<Bool> {
        Binding(get: { chosen.contains(id) }, set: { on in if on { chosen.insert(id) } else { chosen.remove(id) } })
    }
}
