import SwiftUI

/// Pick one of a few options, as rows in a panel: an amber radio, the option's words, and the chosen
/// one's details right under it.
struct OptionList<Value: Hashable, Detail: View>: View {
    let options: [(Value, String)]
    @Binding var selection: Value
    @ViewBuilder var detail: (Value) -> Detail

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(options.enumerated()), id: \.offset) { i, option in
                let on = option.0 == selection
                if i > 0 { Rectangle().fill(Theme.hairline).frame(height: 1) }
                HStack(alignment: .top, spacing: 12) {
                    Radio(on: on).padding(.top, 2)
                    VStack(alignment: .leading, spacing: 8) {
                        Text(option.1).font(Theme.sans(14, on ? .medium : .regular)).foregroundStyle(on ? Theme.text : Theme.textSec)
                        if on { detail(option.0) }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 13)
                .background(on ? Color.white.opacity(0.03) : .clear)
                .contentShape(Rectangle())
                .onTapGesture { selection = option.0 }
            }
        }
        .panel()
    }
}

struct Radio: View {
    let on: Bool

    var body: some View {
        ZStack {
            Circle().fill(on ? Theme.heat : .clear)
            Circle().stroke(on ? Theme.heat : Theme.textMuted, lineWidth: 1.5)
            if on { Circle().fill(Theme.bg).frame(width: 6, height: 6) }
        }
        .frame(width: 16, height: 16)
    }
}

/// A row of choices where exactly one is on (the agent: Claude Code, Codex…).
struct Segmented<Value: Hashable>: View {
    let options: [(Value, String)]
    @Binding var selection: Value

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                let on = option.0 == selection
                Text(option.1)
                    .font(Theme.sans(13, on ? .medium : .regular))
                    .foregroundStyle(on ? Theme.text : Theme.textSec)
                    .padding(.horizontal, 14)
                    .frame(height: 28)
                    .background(RoundedRectangle(cornerRadius: 5).fill(on ? Theme.surfaceHover : .clear))
                    .contentShape(Rectangle())
                    .onTapGesture { selection = option.0 }
            }
        }
        .padding(3)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.black.opacity(0.22)))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.hairline))
    }
}

/// A box you tick, in the Forge look.
struct CheckRow<Label: View>: View {
    @Binding var on: Bool
    @ViewBuilder var label: () -> Label

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 4).fill(on ? Theme.heat : .clear)
                RoundedRectangle(cornerRadius: 4).stroke(on ? Theme.heat : Theme.textMuted, lineWidth: 1.5)
                if on { Image(systemName: "checkmark").font(.system(size: 9, weight: .heavy)).foregroundStyle(Theme.bg) }
            }
            .frame(width: 16, height: 16)
            .padding(.top, 2)
            label()
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .onTapGesture { on.toggle() }
    }
}
