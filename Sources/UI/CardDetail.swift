import SwiftUI

/// A card's detail: what its agent is doing, its helpers, recent activity, the branch and pull request,
/// and the workpad (the agent's one running note on the card).
struct CardDetail: View {
    @ObservedObject var model: AppModel
    let card: EngineState.Card
    let close: () -> Void
    @State private var workpad: String?
    @State private var loaded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(card.identifier) · \(card.state)").font(.system(size: 12)).foregroundStyle(.secondary)
                    Text(card.title).font(.system(size: 18, weight: .semibold))
                }
                Spacer()
                Button("Done", action: close).keyboardShortcut(.cancelAction)
            }
            .padding(.bottom, 14)
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    agentSection
                    linksSection
                    section("Workpad") {
                        if let workpad,
                            let text = try? AttributedString(markdown: workpad, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
                        {
                            Text(text).font(.system(size: 12)).textSelection(.enabled)
                        } else {
                            Text(loaded ? "No workpad on this card yet." : "Reading…").font(.system(size: 12)).foregroundStyle(.secondary)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(24)
        .frame(width: 620, height: 560)
        .background(Color(nsColor: .windowBackgroundColor))
        .task {
            workpad = model.preview ? model.sample.workpad : await model.link.workpad(card: card.id)?.workpad
            loaded = true
        }
    }

    @ViewBuilder private var agentSection: some View {
        if let agent = card.agent {
            section("Agent") {
                Text(card.activity ?? "Working").font(.system(size: 13))
                Text("Turn \(agent.turn) · attempt \(agent.attempt)").font(.system(size: 12)).foregroundStyle(.secondary)
                ForEach(card.helpers) { h in
                    Label(h.description, systemImage: h.running ? "circle.dotted" : "checkmark.circle")
                        .font(.system(size: 12))
                        .foregroundStyle(h.running ? .primary : .secondary)
                }
                if let recent = card.recent, !recent.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(recent.suffix(12).reversed(), id: \.self) { l in
                            Text("\(Self.time(l.at))  \(l.line)").font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.top, 4)
                }
            }
        } else {
            section("Agent") {
                Text("No agent has this card right now.").font(.system(size: 12)).foregroundStyle(.secondary)
            }
        }
    }

    private var linksSection: some View {
        section("Code") {
            if let b = card.branchName { Text("Branch \(b)").font(.system(size: 12, design: .monospaced)) }
            HStack(spacing: 14) {
                if let pr = card.prUrl { Button("Open the pull request") { model.openLink(pr) }.buttonStyle(.link) }
                if let u = card.url { Button("Open in Linear") { model.openLink(u) }.buttonStyle(.link) }
            }
            .font(.system(size: 12))
        }
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
            content()
        }
    }

    static func time(_ iso: String) -> String {
        guard let d = ISO8601DateFormatter.withFraction.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return "" }
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: d)
    }
}

extension ISO8601DateFormatter {
    nonisolated(unsafe) static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
