import SwiftUI

/// Workflow Studio's "What others see": the "Keep Forge invisible" switch, the pull request label and the branch
/// prefix (Direction A, Nov 9). With the switch on, pull requests, branches, commits and card notes carry no
/// mark of Forge; the engine enforces it (engine `tracker/marks.ts`, `workspace/marks-guard.ts`).
struct WhatOthersSee: View {
    @Binding var invisible: Bool
    @Binding var label: String
    @Binding var prefix: String
    /// A card id shaped like this board's, for the branch example.
    let sampleCard: String
    /// The tracker's own branch name for that card, used when there's no prefix.
    let trackerBranch: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel(text: "What others see")
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Keep Forge invisible").font(Theme.sans(.body, .medium)).foregroundStyle(Theme.text)
                    Text(
                        invisible
                            ? "Nothing says Forge. Pull requests, branches, commits and card notes look like your own work."
                            : "Off: pull requests get the forge label."
                    )
                    .font(Theme.sans(.caption)).foregroundStyle(Theme.textSec).fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                ForgeToggle(
                    on: Binding(
                        get: { invisible },
                        set: { on in
                            invisible = on
                            if on, label == "forge" { label = "" }
                        }))
            }
            if invisible {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Self.promises, id: \.self) { line in
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "checkmark").font(Theme.icon(.glyphXS, .bold)).foregroundStyle(Theme.good).padding(.top, 3)
                            Text(line).font(Theme.sans(.small)).foregroundStyle(Theme.textSec).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            field("Pull request label", text: $label, hint: "None")
            field("Branch prefix", text: Binding(get: { prefix }, set: { prefix = Self.cleanPrefix($0) }), hint: "None")
            Text("Branches look like \(Self.branch(card: sampleCard, prefix: prefix, tracker: trackerBranch))")
                .font(Theme.mono(.caption)).foregroundStyle(Theme.textMuted).fixedSize(horizontal: false, vertical: true)
        }
    }

    static let promises = [
        "No label on pull requests",
        "Card notes headed Workpad, no folder path",
        "Branches start with your prefix",
        "Commits signed as you only",
    ]

    private func field(_ title: String, text: Binding<String>, hint: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(Theme.sans(.small, .medium)).foregroundStyle(Theme.textSec)
            TextField("", text: text).forgeField(mono: true, hint: hint, empty: text.wrappedValue.isEmpty)
        }
    }

    /// Only what git takes in a branch name: letters, digits, `.`, `_`, `/` and `-`.
    static func cleanPrefix(_ s: String) -> String {
        String(s.filter { $0.isASCII && ($0.isLetter || $0.isNumber || "._/-".contains($0)) })
    }

    /// The branch a card gets: the prefix plus its id in lowercase (engine worker/branch.ts), else the tracker's.
    static func branch(card: String, prefix: String, tracker: String) -> String {
        prefix.isEmpty ? tracker : prefix + card.lowercased().replacingOccurrences(of: "#", with: "-")
    }
}
