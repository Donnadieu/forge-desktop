import AppKit
import SwiftUI

/// Forge's file viewer: a file a link in the chat points at, from the session's worktree. Markdown is drawn rendered
/// (its own links work too), a diff in red and green with its code coloured, anything else as numbered code. Show in
/// Finder, Close, Esc or a click outside.
struct FileSheet: View {
    @ObservedObject var sessions: SessionsModel
    let file: FileLinks.Opened
    let close: () -> Void

    /// The most the viewer reads of a file; a longer one shows its start and says so.
    static let limit = 2_000_000

    /// The file's text (nil: it isn't text) and whether it was cut at `limit`.
    @MainActor static func read(_ url: URL) -> (text: String?, cut: Bool) {
        let changed = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
        if let hit = cache[url], hit.changed == changed { return hit.read }
        let read = load(url)
        cache = [url: (changed, read)]
        return read
    }

    @MainActor private static var cache: [URL: (changed: Date?, read: (text: String?, cut: Bool))] = [:]

    private static func load(_ url: URL) -> (text: String?, cut: Bool) {
        guard let h = try? FileHandle(forReadingFrom: url) else { return (nil, false) }
        defer { try? h.close() }
        let data = (try? h.read(upToCount: limit + 1)) ?? Data()
        let head = data.prefix(limit)
        if head.prefix(8000).contains(0) { return (nil, false) }
        return (String(decoding: head, as: UTF8.self), data.count > limit)
    }

    /// The path as the chat names it: from the worktree's top.
    var shown: String {
        let root = URL(fileURLWithPath: file.root).standardizedFileURL.path
        let p = file.url.path
        return p.hasPrefix(root + "/") ? String(p.dropFirst(root.count + 1)) : p
    }

    var body: some View {
        ZStack {
            Color.black.opacity(0.5).onTapGesture(perform: close)
            VStack(alignment: .leading, spacing: 0) {
                header
                Rectangle().fill(Theme.border).frame(height: 1)
                content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .frame(width: 900, height: 620)
            .background(RoundedRectangle(cornerRadius: Theme.rXl).fill(Theme.bg))
            .overlay(RoundedRectangle(cornerRadius: Theme.rXl).stroke(Theme.border))
            .clipShape(RoundedRectangle(cornerRadius: Theme.rXl))
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "doc.text").font(.system(size: 11)).foregroundStyle(Theme.textMuted)
            Text(shown).font(Theme.mono(12)).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
            Spacer()
            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([file.url]) }
                .buttonStyle(ForgeButton(kind: .ghost, icon: "folder"))
            Button("Close", action: close).buttonStyle(ForgeButton(kind: .ghost)).keyboardShortcut(.escape, modifiers: [])
        }
        .padding(16)
    }

    @ViewBuilder private var content: some View {
        let read = Self.read(file.url)
        if let text = read.text {
            VStack(alignment: .leading, spacing: 0) {
                if read.cut {
                    Text("Showing the first 2 MB of this file.").font(Theme.sans(11)).foregroundStyle(Theme.textMuted)
                        .padding(.horizontal, 16).padding(.vertical, 6)
                }
                switch FileKind.of(path: file.url.path, text: text) {
                case .markdown:
                    ScrollView {
                        MessageText(text: String(text.prefix(200_000))).padding(24)
                    }
                    .opensFileLinks(sessions, root: file.root)
                case .diff: DiffLines(text: text, language: Syntax.language(path: file.url.path), files: true)
                case .code: CodeLines(text: text, language: Syntax.language(path: file.url.path))
                }
            }
        } else {
            Text("This file isn't text. Show in Finder to open it with another app.").font(Theme.sans(13)).foregroundStyle(Theme.textSec)
                .padding(24)
        }
    }
}

/// A file's lines, numbered, coloured by its language, in a native list so a long file stays smooth.
struct CodeLines: View {
    let text: String
    var language: String?

    var body: some View {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).prefix(50_000).enumerated().map { ($0.offset, String($0.element)) }
        List(lines, id: \.0) { n, line in
            HStack(spacing: 8) {
                Text("\(n + 1)").font(Theme.mono(10)).foregroundStyle(Theme.textMuted).frame(width: 40, alignment: .trailing)
                Text(line.isEmpty ? AttributedString(" ") : Syntax.attributed(line, language: language)).font(Theme.mono(11)).lineLimit(1)
                    .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading).frame(height: 18)
            .padding(.horizontal, 8)
            .listRowInsets(EdgeInsets()).listRowSeparator(.hidden).listRowBackground(Color.clear)
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 18)
        .scrollContentBackground(.hidden)
    }
}
