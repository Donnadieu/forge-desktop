import SwiftUI

/// The frame every setup screen shares: the steps on the left, one question, one main button.
struct SetupFrame<Content: View>: View {
    @ObservedObject var model: AppModel
    let question: String
    let detail: String
    let primary: String
    let primaryEnabled: Bool
    let busy: Bool
    let action: () -> Void
    /// A second, quieter choice beside the main button ("Skip for now").
    var secondary: (title: String, action: () -> Void)? = nil
    @ObservedObject var updater = Updater.shared
    @ViewBuilder let content: () -> Content

    var body: some View {
        HStack(spacing: 0) {
            SetupSidebar(model: model, updater: updater)
            VStack(alignment: .leading, spacing: 0) {
                TitleBarSpace(title: AppInfo.name)
                VStack(alignment: .leading, spacing: 0) {
                    Text(question)
                        .font(Theme.display(34))
                        .foregroundStyle(Theme.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.bottom, 10)
                    Text(detail)
                        .font(Theme.sans(14))
                        .foregroundStyle(Theme.textSec)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: 580, alignment: .leading)
                        .padding(.bottom, 28)
                    content()
                    Spacer(minLength: 16)
                    footer
                }
                .padding(.horizontal, 56)
                .padding(.top, 12)
                .padding(.bottom, 24)
                .frame(maxWidth: 980, alignment: .leading)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private var footer: some View {
        HStack(spacing: 12) {
            if model.screen > 0 {
                Button("Back") { model.go(model.screen - 1) }
                    .buttonStyle(ForgeButton(kind: .secondary, hint: "⌘[", large: true))
                    .keyboardShortcut("[", modifiers: .command)
            }
            Spacer()
            if busy { ProgressView().controlSize(.small).padding(.trailing, 4) }
            if let s = secondary {
                Button(s.title, action: s.action)
                    .buttonStyle(ForgeButton(kind: .secondary, large: true))
                    .disabled(busy)
            }
            Button(primary, action: action)
                .buttonStyle(ForgeButton(kind: .primary, hint: "↵", large: true))
                .keyboardShortcut(.defaultAction)
                .disabled(!primaryEnabled || busy)
        }
    }
}

/// The steps down the left: done (amber tick), here (highlighted), to come (dim).
struct SetupSidebar: View {
    @ObservedObject var model: AppModel
    @ObservedObject var updater: Updater

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Color.clear.frame(height: TitleBarSpace.height)
            HStack(spacing: 10) {
                AnvilMark().sized(22)
                Text(AppInfo.name).font(Theme.serif(19)).foregroundStyle(Theme.text)
            }
            .padding(.leading, 20)
            .padding(.bottom, 30)
            SectionLabel(text: "Setup").padding(.leading, 20).padding(.bottom, 10)
            ForEach(Array(AppModel.screenTitles.enumerated()), id: \.offset) { i, title in
                StepRow(number: i + 1, title: title, state: i < model.screen ? .done : (i == model.screen ? .here : .later))
            }
            Spacer()
            if let rel = updater.available, !model.preview {
                // Answers are saved screen by screen, so updating mid-setup picks up where it left off.
                Button(updater.installing ? "Updating…" : "Update to \(rel.version)") { Task { await updater.install() } }
                    .buttonStyle(ForgeButton(kind: .fix))
                    .disabled(updater.installing)
                    .padding(20)
            }
        }
        .frame(width: 224, alignment: .topLeading)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.sidebar)
        .overlay(alignment: .trailing) { Rectangle().fill(Theme.hairline).frame(width: 1) }
    }
}

struct StepRow: View {
    enum Mark { case done, here, later }
    let number: Int
    let title: String
    let state: Mark

    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                switch state {
                case .done:
                    Circle().fill(Theme.heat)
                    Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.bg)
                case .here:
                    Circle().stroke(Theme.text, lineWidth: 1.5)
                    Text("\(number)").font(Theme.sans(10, .semibold)).foregroundStyle(Theme.text)
                case .later:
                    Circle().stroke(Theme.textMuted.opacity(0.6), lineWidth: 1)
                    Text("\(number)").font(Theme.sans(10)).foregroundStyle(Theme.textMuted)
                }
            }
            .frame(width: 18, height: 18)
            Text(title)
                .font(Theme.sans(14, state == .here ? .semibold : .regular))
                .foregroundStyle(state == .here ? Theme.text : (state == .done ? Theme.textSec : Theme.textMuted))
            Spacer()
        }
        .padding(.horizontal, 8)
        .frame(height: 32)
        .background(RoundedRectangle(cornerRadius: 6).fill(state == .here ? Theme.surface : .clear))
        .padding(.horizontal, 12)
        .padding(.vertical, 1)
    }
}

/// The strip the hidden title bar sits in: room for the window buttons and the window's name.
struct TitleBarSpace: View {
    static let height: CGFloat = 52
    let title: String

    var body: some View {
        HStack {
            Text(title).font(Theme.sans(13, .medium)).foregroundStyle(Theme.textSec)
            Spacer()
        }
        .padding(.horizontal, 24)
        .frame(height: Self.height)
    }
}

/// The window's three buttons, drawn only in screen renders (the real window draws its own).
struct TrafficLights: View {
    var body: some View {
        HStack(spacing: 8) {
            ForEach([0xFF5F57, 0xFEBC2E, 0x28C840] as [UInt32], id: \.self) { Circle().fill(Color(hex: $0)).frame(width: 12, height: 12) }
        }
        .padding(.leading, 20)
        .frame(height: TitleBarSpace.height)
    }
}

/// A short plain-words problem line under a field.
struct ProblemLine: View {
    let text: String?

    var body: some View {
        if let text {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "exclamationmark.triangle").font(.system(size: 12, weight: .medium))
                Text(text).font(Theme.sans(13)).fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(Theme.heatBright)
            .padding(.top, 12)
        }
    }
}

/// A short plain-words "all good" line.
struct GoodLine: View {
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "checkmark.circle.fill").font(.system(size: 12)).foregroundStyle(Theme.good)
            Text(text).font(Theme.sans(13)).foregroundStyle(Theme.textSec)
        }
    }
}
