import SwiftUI

/// One file's diff, a row per line in a native list (thousands of lines stay smooth). With `pick`, a click picks a
/// line and a Shift-click a range, so the person can comment on it.
struct DiffLines: View {
    let text: String
    var picked: ClosedRange<Int>? = nil
    var pick: ((Int, Bool) -> Void)? = nil

    struct Line: Identifiable {
        let id: Int
        let text: String
        /// Its number in the new file (nil for a removed line or a hunk header).
        let number: Int?
    }

    static func lines(_ text: String) -> [Line] {
        var out: [Line] = []
        var next = 0
        for (i, raw) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
            let l = String(raw)
            if l.hasPrefix("diff --git") || l.hasPrefix("index ") || l.hasPrefix("+++") || l.hasPrefix("---") { continue }
            if l.hasPrefix("@@") {
                // @@ -a,b +c,d @@: the new file's lines start at c.
                let plus = l.split(separator: " ").first { $0.hasPrefix("+") }
                next = Int(plus?.dropFirst().split(separator: ",").first ?? "") ?? 0
                out.append(Line(id: i, text: l, number: nil))
            } else if l.hasPrefix("-") {
                out.append(Line(id: i, text: l, number: nil))
            } else {
                out.append(Line(id: i, text: l, number: next > 0 ? next : nil))
                if next > 0 { next += 1 }
            }
        }
        return out
    }

    var body: some View {
        List(Self.lines(text)) { l in
            HStack(spacing: 8) {
                Text(l.number.map(String.init) ?? "").font(Theme.mono(10)).foregroundStyle(Theme.textMuted).frame(width: 40, alignment: .trailing)
                Text(l.text.isEmpty ? " " : l.text).font(Theme.mono(11)).foregroundStyle(l.text.hasPrefix("@@") ? Theme.textMuted : Theme.text)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading).frame(height: 18)
            .padding(.horizontal, 8)
            .background(picked?.contains(l.id) == true ? Theme.heat.opacity(0.18) : background(l.text))
            .contentShape(Rectangle())
            .onTapGesture { pick?(l.id, NSEvent.modifierFlags.contains(.shift)) }
            .listRowInsets(EdgeInsets()).listRowSeparator(.hidden).listRowBackground(Color.clear)
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 18)
        .scrollContentBackground(.hidden)
    }

    private func background(_ l: String) -> Color {
        if l.hasPrefix("+") { return Theme.goodWash }
        if l.hasPrefix("-") { return Theme.badWash }
        if l.hasPrefix("@@") { return Theme.wash1 }
        return .clear
    }
}

/// A file's diff in a sheet. Pick a line or a range and write a comment: it joins the chat's message box, quoted with
/// the file and line numbers, ready to send with anything else.
struct DiffSheet: View {
    let path: String
    let text: String
    var comment: ((String) -> Void)? = nil
    let close: () -> Void
    @State private var picked: ClosedRange<Int>?
    @State private var note = ""

    var body: some View {
        ZStack {
            Color.black.opacity(0.5).onTapGesture(perform: close)
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text(path).font(Theme.mono(12)).foregroundStyle(Theme.text)
                    Spacer()
                    if comment != nil, picked == nil {
                        Text("Click a line to comment on it").font(Theme.sans(11)).foregroundStyle(Theme.textMuted)
                    }
                    Button("Close", action: close).buttonStyle(ForgeButton(kind: .ghost)).keyboardShortcut(.escape, modifiers: [])
                }
                .padding(16)
                DiffLines(text: text, picked: picked, pick: comment == nil ? nil : pick)
                if let picked, comment != nil {
                    HStack(spacing: 8) {
                        TextField("", text: $note).forgeField(hint: "Comment on \(Self.where(path, text, picked))", empty: note.isEmpty)
                            .onSubmit(add)
                        Button("Add to message", action: add).buttonStyle(ForgeButton(kind: .primary))
                            .disabled(note.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    .padding(12)
                    .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
                }
            }
            .frame(width: 900, height: 600)
            .background(RoundedRectangle(cornerRadius: Theme.rXl).fill(Theme.bg))
            .overlay(RoundedRectangle(cornerRadius: Theme.rXl).stroke(Theme.border))
        }
    }

    private func pick(_ id: Int, _ extend: Bool) {
        if extend, let p = picked { picked = min(p.lowerBound, id)...max(p.upperBound, id) } else { picked = id...id }
    }

    private func add() {
        guard let picked, let comment, !note.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        comment(Self.quote(path: path, diff: text, range: picked, note: note))
        close()
    }

    /// "lines 12–14" (new-file numbers) for the picked rows.
    static func `where`(_ path: String, _ diff: String, _ range: ClosedRange<Int>) -> String {
        let nums = DiffLines.lines(diff).filter { range.contains($0.id) }.compactMap(\.number)
        guard let a = nums.first, let b = nums.last else { return path }
        return a == b ? "line \(a)" : "lines \(a)–\(b)"
    }

    /// The comment as it joins the message: where, the lines quoted, then what the person wrote.
    static func quote(path: String, diff: String, range: ClosedRange<Int>, note: String) -> String {
        let rows = DiffLines.lines(diff).filter { range.contains($0.id) }
        let code = rows.map { "> " + $0.text }.joined(separator: "\n")
        return "On `\(path)` \(Self.where(path, diff, range)):\n\(code)\n\(note.trimmingCharacters(in: .whitespacesAndNewlines))"
    }
}
