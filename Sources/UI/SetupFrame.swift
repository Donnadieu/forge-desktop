import SwiftUI

/// The frame every setup screen shares: where you are, one question, one main button.
struct SetupFrame<Content: View>: View {
    @ObservedObject var model: AppModel
    let question: String
    let detail: String
    let primary: String
    let primaryEnabled: Bool
    let busy: Bool
    let action: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            StepDots(current: model.screen)
                .padding(.bottom, 28)
            Text(question)
                .font(.system(size: 26, weight: .semibold))
                .padding(.bottom, 8)
            Text(detail)
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 24)
            content()
            Spacer(minLength: 16)
            HStack {
                if model.screen > 0 {
                    Button("Back") { model.go(model.screen - 1) }
                        .keyboardShortcut(.cancelAction)
                }
                Spacer()
                if busy { ProgressView().controlSize(.small).padding(.trailing, 8) }
                Button(primary, action: action)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!primaryEnabled || busy)
                    .controlSize(.large)
            }
        }
        .padding(40)
        .frame(maxWidth: 640, alignment: .leading)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Six dots: done, here, to come.
struct StepDots: View {
    let current: Int

    var body: some View {
        HStack(spacing: 14) {
            ForEach(0..<AppModel.screenTitles.count, id: \.self) { i in
                HStack(spacing: 6) {
                    Circle()
                        .fill(i < current ? Color.accentColor : (i == current ? Color.primary : Color.secondary.opacity(0.3)))
                        .frame(width: 8, height: 8)
                    Text(AppModel.screenTitles[i])
                        .font(.system(size: 12, weight: i == current ? .semibold : .regular))
                        .foregroundStyle(i == current ? .primary : .secondary)
                }
            }
        }
    }
}

/// A short plain-words problem line under a field.
struct ProblemLine: View {
    let text: String?

    var body: some View {
        if let text {
            Label(text, systemImage: "exclamationmark.triangle.fill")
                .font(.system(size: 13))
                .foregroundStyle(.orange)
                .padding(.top, 10)
        }
    }
}

/// A short plain-words "all good" line.
struct GoodLine: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "checkmark.circle.fill")
            .font(.system(size: 13))
            .foregroundStyle(.green)
    }
}
