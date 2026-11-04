import SwiftUI

/// The moves a person makes from the Orchestrator: start a card triage marked ready (Backlog to Todo),
/// and decide on a pull request (Human Review to Merging or Rework), one card or all of them at once.
enum CardMoves {
    /// The label triage puts on a card it planned, so it can be built.
    static let readyLabel = "ready-for-execution"

    static func isReady(_ c: EngineState.Card) -> Bool { c.labels?.contains(readyLabel) == true }

    /// Why a card waiting in Todo isn't moving: the unfinished cards that block it.
    static func waitingLine(_ c: EngineState.Card) -> String? {
        guard let b = c.blockedBy, !b.isEmpty else { return nil }
        return "Waiting on " + b.joined(separator: ", ")
    }

    /// A bulk button shows only when there are two cards or more to move.
    static func showsBulk(_ cards: [EngineState.Card]) -> Bool { cards.count >= 2 }
}

/// A move of several cards at once, waiting for the person's yes.
struct BulkMove: Identifiable, Equatable {
    enum Kind { case merge, start }
    let kind: Kind
    let cards: [EngineState.Card]
    var id: String { "\(kind)-" + cards.map(\.id).joined(separator: ",") }

    var to: String { kind == .merge ? "Merging" : "Todo" }
    var title: String {
        let n = cards.count
        return kind == .merge ? "Merge \(n) pull request\(n == 1 ? "" : "s")?" : "Start \(n) card\(n == 1 ? "" : "s")?"
    }
    var line: String {
        kind == .merge
            ? "Each card moves to Merging. An agent merges each pull request once its checks pass."
            : "They move to Todo and agents pick them up in order."
    }
    var button: String { kind == .merge ? "Merge all" : "Start all" }
}

/// The small sheet that asks before a bulk move (same look as the sign-in guide). Closes with its X,
/// Esc, Cancel or a click outside it.
struct MoveConfirm: View {
    let move: BulkMove
    let cancel: () -> Void
    let confirm: () -> Void

    var body: some View {
        ZStack {
            Theme.bg.opacity(0.72).ignoresSafeArea().onTapGesture(perform: cancel)
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 16) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(move.title).font(Theme.display(24)).foregroundStyle(Theme.text)
                        Text(move.line).font(Theme.sans(13)).foregroundStyle(Theme.textSec).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                    Button(action: cancel) {
                        Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.textSec)
                            .frame(width: 28, height: 28)
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(.cancelAction)
                }
                .padding(.horizontal, 24).padding(.vertical, 20)
                .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(move.cards) { c in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(c.identifier).foregroundStyle(Theme.textMuted)
                            Text(c.title).foregroundStyle(Theme.text).lineLimit(1)
                        }
                        .font(Theme.mono(12))
                    }
                }
                .padding(24)
                HStack(spacing: 8) {
                    Spacer()
                    Button("Cancel", action: cancel).buttonStyle(ForgeButton(kind: .ghost))
                    Button(move.button, action: confirm).buttonStyle(ForgeButton(kind: .primary)).keyboardShortcut(.defaultAction)
                }
                .padding(.horizontal, 24).padding(.bottom, 20)
            }
            .frame(width: 520)
            .background(RoundedRectangle(cornerRadius: Theme.rXl).fill(Theme.surface))
            .clipShape(RoundedRectangle(cornerRadius: Theme.rXl))
            .overlay(RoundedRectangle(cornerRadius: Theme.rXl).stroke(Theme.border))
            .shadow(color: .black.opacity(0.4), radius: 16, y: 4)
        }
    }
}
