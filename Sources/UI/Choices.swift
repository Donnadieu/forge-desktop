import SwiftUI

/// `.opts`: pick one of a few options, each its own row with a radio, the option's words, and the
/// chosen one's details right under it.
struct OptionList<Value: Hashable, Detail: View>: View {
    let options: [(Value, String)]
    @Binding var selection: Value
    /// One plain line under each option's name.
    var lines: [Value: String] = [:]
    var disabled: Set<Value> = []
    @ViewBuilder var detail: (Value) -> Detail

    var body: some View {
        VStack(spacing: 8) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                let on = option.0 == selection
                let off = disabled.contains(option.0)
                HStack(alignment: .top, spacing: 12) {
                    Radio(on: on).padding(.top, 2)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(option.1).font(Theme.sans(13, .semibold)).foregroundStyle(Theme.text)
                        if let line = lines[option.0] {
                            Text(line).font(Theme.sans(13)).foregroundStyle(Theme.textSec).fixedSize(horizontal: false, vertical: true)
                        }
                        if on { detail(option.0).padding(.top, 6) }
                    }
                    Spacer(minLength: 0)
                }
                .padding(16)
                .background(RoundedRectangle(cornerRadius: Theme.rLg).fill(on ? Theme.surfaceHover : Theme.surface))
                .overlay(RoundedRectangle(cornerRadius: Theme.rLg).stroke(on ? Theme.borderHover : Theme.border))
                .opacity(off ? 0.4 : 1)
                .contentShape(Rectangle())
                .onTapGesture { if !off { selection = option.0 } }
            }
        }
    }
}

/// `.radio`: cream when on.
struct Radio: View {
    let on: Bool

    var body: some View {
        ZStack {
            Circle().fill(on ? Theme.text : .clear)
            Circle().stroke(on ? Theme.text : Theme.borderHover, lineWidth: 1)
            if on { Circle().fill(Theme.surfaceHover).frame(width: 8, height: 8) }
        }
        .frame(width: 16, height: 16)
    }
}

/// `.seg`: a row of equal choices where exactly one is on. `heat` marks the choice in amber (agents at
/// once), otherwise it's the neutral highlight (the agent).
struct Segmented<Value: Hashable>: View {
    let options: [(Value, String)]
    @Binding var selection: Value
    var heat = false
    var mono = false

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(options.enumerated()), id: \.offset) { i, option in
                let on = option.0 == selection
                if i > 0 { Rectangle().fill(Theme.border).frame(width: 1) }
                Text(option.1)
                    .font(mono ? Theme.mono(13, on ? .medium : .regular) : Theme.sans(13, .medium))
                    .foregroundStyle(on ? (heat ? Theme.heatBright : Theme.text) : Theme.textSec)
                    .frame(maxWidth: .infinity)
                    .frame(height: 36)
                    .background(on ? (heat ? Theme.heatWash : Theme.surfaceHover) : .clear)
                    .overlay(Rectangle().stroke(on ? (heat ? Theme.heatBorder : Theme.borderHover) : .clear))
                    .contentShape(Rectangle())
                    .onTapGesture { selection = option.0 }
            }
        }
        .frame(height: 36)
        .clipShape(RoundedRectangle(cornerRadius: Theme.rMd))
        .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.border))
    }
}

/// `.cb`: a box you tick.
struct CheckRow<Label: View>: View {
    @Binding var on: Bool
    @ViewBuilder var label: () -> Label

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: Theme.rSm).fill(on ? Theme.text : .clear)
                RoundedRectangle(cornerRadius: Theme.rSm).stroke(on ? Theme.text : Theme.borderHover, lineWidth: 1)
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
