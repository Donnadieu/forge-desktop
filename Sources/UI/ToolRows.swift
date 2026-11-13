import SwiftUI

/// How a kind of tool shows in the transcript: its mark, so what ran is plain at a glance.
struct ToolStyle: Equatable {
    let icon: String

    static func of(_ name: String?) -> ToolStyle {
        switch name ?? "" {
        case "Bash", "BashOutput", "KillShell": return ToolStyle(icon: "terminal")
        case "Read", "NotebookRead": return ToolStyle(icon: "doc.text")
        case "Edit", "MultiEdit", "Write", "NotebookEdit": return ToolStyle(icon: "pencil")
        case "Grep", "Glob", "WebSearch": return ToolStyle(icon: "magnifyingglass")
        case "Task", "Agent": return ToolStyle(icon: "person.2")
        case "WebFetch": return ToolStyle(icon: "globe")
        case "TodoWrite": return ToolStyle(icon: "checklist")
        default: return ToolStyle(icon: "wrench")
        }
    }
}

/// What an opened tool row shows: the command that ran, what it printed, or the lines an edit took out and put in.
enum ToolDetail: Equatable {
    case command(String)
    case output(String, failed: Bool)
    case change(removed: [String], added: [String])

    static func parts(_ event: Sessions.Event, _ result: Sessions.Event?) -> [ToolDetail] {
        var out: [ToolDetail] = []
        if case .object(let input)? = event.data {
            if let cmd = input["command"]?.string { out.append(.command(cmd)) }
            if let edits = input["edits"]?.array {
                for e in edits { out.append(change(e["old_string"]?.string, e["new_string"]?.string)) }
            } else if input["new_string"] != nil || input["old_string"] != nil {
                out.append(change(input["old_string"]?.string, input["new_string"]?.string))
            } else if let content = input["content"]?.string {
                out.append(.change(removed: [], added: lines(String(content.prefix(4000)))))
            }
        }
        if let r = result, !r.text.isEmpty {
            let more = r.size > r.text.count ? "\n… \(r.size - r.text.count) more characters" : ""
            out.append(.output(r.text + more, failed: r.isError))
        }
        return out
    }

    private static func change(_ old: String?, _ new: String?) -> ToolDetail {
        .change(removed: lines(old ?? ""), added: lines(new ?? ""))
    }

    private static func lines(_ s: String) -> [String] {
        s.isEmpty ? [] : s.components(separatedBy: "\n")
    }
}

/// One tool call: its mark and summary on one line ("Ran make lint"); a click opens the command, its output in a
/// terminal-like panel, or an edit's lines in red and green. A failed call is tinted.
struct ToolRow: View {
    let event: Sessions.Event
    let result: Sessions.Event?
    let running: Bool
    @State private var open: Bool
    @Environment(\.worktree) private var worktree
    @Environment(\.openURL) private var openURL

    /// Rows a render draws opened (`--render-screens` can't click).
    @MainActor static var openInRender: Set<String> = []

    @MainActor init(event: Sessions.Event, result: Sessions.Event?, running: Bool) {
        self.event = event
        self.result = result
        self.running = running
        _open = State(initialValue: Self.openInRender.contains(event.id))
    }

    private var parts: [ToolDetail] { ToolDetail.parts(event, result) }
    private var failed: Bool { result?.isError == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                summary
                if let file { openButton(file) }
            }
            if open {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(parts.enumerated()), id: \.offset) { i, p in
                        if i > 0 { Rectangle().fill(Theme.border).frame(height: 1) }
                        section(p)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(Theme.bg))
                .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(failed ? Theme.heatBorder : Theme.border))
                .clipShape(RoundedRectangle(cornerRadius: Theme.rMd))
                .padding(.leading, 22)
            }
        }
    }

    /// The folded line: mark, summary, and how it went; a click opens the details.
    private var summary: some View {
        Button {
            if !parts.isEmpty { open.toggle() }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: open ? "chevron.down" : "chevron.right").font(Theme.icon(.glyphTiny, .bold))
                    .foregroundStyle(Theme.textMuted).opacity(parts.isEmpty ? 0.3 : 1)
                Image(systemName: ToolStyle.of(event.name).icon).font(Theme.icon(.glyphS))
                    .foregroundStyle(failed ? Theme.heat : Theme.textMuted).frame(width: 14)
                Text(event.text).font(Theme.mono(.toolTitle)).foregroundStyle(failed ? Theme.heat : Theme.textSec).lineLimit(1)
                if running { Spinner() }
                if failed { Text("failed").font(Theme.mono(.toolMeta)).foregroundStyle(Theme.heat) }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// The file the tool read or wrote, when it's in the session's worktree.
    private var file: URL? { event.data?["file_path"]?.string.flatMap { FileLinks.resolve($0, root: worktree) } }

    private func openButton(_ url: URL) -> some View {
        Button {
            openURL(url)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "arrow.up.forward.square").font(Theme.icon(.glyphS))
                Text("Open").font(Theme.mono(.toolMeta))
            }
            .foregroundStyle(Theme.heatBright)
        }
        .buttonStyle(.plain)
        .help("Open \(url.lastPathComponent) in Forge · ⌘-click shows it in Finder")
    }

    @ViewBuilder private func section(_ p: ToolDetail) -> some View {
        switch p {
        case .command(let c):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("$").font(Theme.mono(.toolTitle, .medium)).foregroundStyle(Theme.heatBright)
                Text(FileLinks.linked(c, root: worktree)).font(Theme.mono(.toolTitle)).foregroundStyle(Theme.text).textSelection(.enabled)
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.wash1)
        case .output(let text, let failed):
            ScrollView {
                Text(FileLinks.linked(text, root: worktree)).font(Theme.mono(.toolTitle)).foregroundStyle(failed ? Theme.heat : Theme.textSec)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(10)
            }
            .frame(maxHeight: 240)
            .fixedSize(horizontal: false, vertical: true)
        case .change(let removed, let added):
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(removed.prefix(200).enumerated()), id: \.offset) { _, l in line("−", l, Theme.badWash, Theme.heat) }
                ForEach(Array(added.prefix(200).enumerated()), id: \.offset) { _, l in line("+", l, Theme.goodWash, Theme.good) }
            }
            .padding(.vertical, 4)
        }
    }

    /// The edited file's language, so its lines are coloured like the diff.
    private var language: String? { event.data?["file_path"]?.string.flatMap(Syntax.language(path:)) }

    private func line(_ mark: String, _ text: String, _ wash: Color, _ tint: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(mark).font(Theme.mono(.toolTitle)).foregroundStyle(tint).frame(width: 10)
            Text(text.isEmpty ? AttributedString(" ") : Syntax.attributed(text, language: language)).font(Theme.mono(.toolTitle)).lineLimit(1)
                .textSelection(.enabled)
        }
        .padding(.horizontal, 10).frame(maxWidth: .infinity, minHeight: 18, alignment: .leading)
        .background(wash)
    }
}
