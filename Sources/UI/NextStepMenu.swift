import SwiftUI

/// "Next step" on a card waiting on you: a small list of stage moves (AI review, QA, human review, rework, merge),
/// each with one line saying what picking it does. Picking one runs it now, column or not.
struct NextStepButton: View {
    @ObservedObject var model: AppModel
    let card: EngineState.Card
    @State private var open = false

    var body: some View {
        Button("Next step") { open = true }
            .buttonStyle(ForgeButton(kind: .secondary, icon: "chevron.down"))
            .lineLimit(1).fixedSize()
            .popover(isPresented: $open, arrowEdge: .bottom) {
                NextStepList(steps: CardMoves.nextSteps(card, model.choices)) { step in
                    open = false
                    Task { await model.link.nextStep(card, stage: step.stage) }
                }
            }
    }
}

/// The list inside Next step (also drawn on its own for screen renders).
struct NextStepList: View {
    let steps: [CardMoves.NextStep]
    let pick: (CardMoves.NextStep) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: "Next step").padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 6)
            ForEach(steps) { step in
                Button {
                    pick(step)
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        StageDot(stage: step.stage)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(step.label).font(Theme.sans(.body, .medium)).foregroundStyle(Theme.text)
                            Text(step.hint).font(Theme.sans(.small)).foregroundStyle(Theme.textSec)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.bottom, 8)
        .frame(width: 320)
        .background(Theme.surface)
    }
}
