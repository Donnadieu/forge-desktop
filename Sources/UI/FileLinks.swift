import AppKit
import SwiftUI

/// Paths in the agent's words and tool rows that name a file in the session's worktree become links: a click opens
/// the file in Forge's viewer, a Cmd-click shows it in Finder. Only files that exist and sit inside the worktree
/// (symlinks followed) are links; anything else stays words.
@MainActor
enum FileLinks {
    enum Open: Equatable {
        /// Opens in Forge's file viewer.
        case view(URL)
        /// Cmd-click: shows the file in Finder.
        case reveal(URL)
    }

    /// A file open in the viewer, and the worktree its links resolve against.
    struct Opened: Equatable {
        var url: URL
        var root: String
    }

    /// Path-looking words: letters, digits and `_ . / ~ @ + -`, with an optional `:line` or `:line:column`.
    private static let token = try? NSRegularExpression(pattern: #"[A-Za-z0-9_./~@+\-]+(?::[0-9]+){0,2}"#)
    private static let lineSuffix = try? NSRegularExpression(pattern: #"(?::[0-9]+){1,2}$"#)
    private static let trailing = ".,;:)]'\""

    /// The file a path names inside the worktree, or nil when it doesn't exist, is a folder, or lies outside it.
    static func resolve(_ token: String, root: String?) -> URL? {
        guard let root, !root.isEmpty else { return nil }
        var t = token.trimmingCharacters(in: .whitespacesAndNewlines)
        while let last = t.last, trailing.contains(last) { t.removeLast() }
        if let re = lineSuffix { t = re.stringByReplacingMatches(in: t, range: NSRange(t.startIndex..., in: t), withTemplate: "") }
        if t.hasPrefix("./") { t.removeFirst(2) }
        guard !t.isEmpty, t.count < 1024, !t.hasPrefix("~"), !t.contains("\n"), t.contains("/") || t.dropFirst().contains(".") else { return nil }
        let base = URL(fileURLWithPath: root).standardizedFileURL
        let url = (t.hasPrefix("/") ? URL(fileURLWithPath: t) : base.appendingPathComponent(t)).standardizedFileURL
        let real = url.resolvingSymlinksInPath().path
        let inside = base.resolvingSymlinksInPath().path
        var folder: ObjCBool = false
        guard real.hasPrefix(inside.hasSuffix("/") ? inside : inside + "/"),
            FileManager.default.fileExists(atPath: real, isDirectory: &folder), !folder.boolValue
        else { return nil }
        return url
    }

    /// What a click on a link does; nil for anything that isn't a file in this worktree.
    static func open(_ url: URL, root: String?, command: Bool) -> Open? {
        guard url.isFileURL, let file = resolve(url.path, root: root) else { return nil }
        return command ? .reveal(file) : .view(file)
    }

    /// Plain text (a tool's command or output) with its paths linked.
    static func linked(_ text: String, root: String?) -> AttributedString {
        var a = AttributedString(text)
        link(&a, root: root)
        return a
    }

    /// Links every path in `a` that names a file in the worktree: a whole `code` span, or path-looking words in prose.
    static func link(_ a: inout AttributedString, root: String?) {
        guard let root, !root.isEmpty, let re = token else { return }
        var found: [(Range<AttributedString.Index>, URL)] = []
        for run in a.runs where run.link == nil && found.count < 200 {
            let words = String(a[run.range].characters)
            if run.inlinePresentationIntent?.contains(.code) == true {
                if let url = resolve(words, root: root) { found.append((run.range, url)) }
                continue
            }
            for m in re.matches(in: words, range: NSRange(words.startIndex..., in: words)).prefix(200) {
                guard let r = Range(m.range, in: words), let url = resolve(String(words[r]), root: root) else { continue }
                // Trailing punctuation isn't part of the link.
                var word = String(words[r])
                while let last = word.last, trailing.contains(last) { word.removeLast() }
                let from = a.characters.index(run.range.lowerBound, offsetBy: words.distance(from: words.startIndex, to: r.lowerBound))
                found.append((from..<a.characters.index(from, offsetBy: word.count), url))
            }
        }
        for (range, url) in found {
            a[range].link = url
            a[range].foregroundColor = Theme.heatBright
            a[range].underlineStyle = .single
        }
    }

    /// Follows a link in the chat: a file in the worktree opens in the viewer (Cmd-click: Finder), another file
    /// opens nothing, and a web link goes to the browser.
    static func action(_ sessions: SessionsModel, root: String) -> OpenURLAction {
        OpenURLAction { url in
            switch open(url, root: root, command: NSEvent.modifierFlags.contains(.command)) {
            case .view(let file)?:
                sessions.openFile = Opened(url: file, root: root)
                return .handled
            case .reveal(let file)?:
                NSWorkspace.shared.activateFileViewerSelecting([file])
                return .handled
            case nil:
                return url.isFileURL ? .discarded : .systemAction
            }
        }
    }
}

/// How Forge's file viewer shows a file.
enum FileKind: Equatable {
    case markdown, diff, code

    static func of(path: String, text: String) -> FileKind {
        let ext = (path as NSString).pathExtension.lowercased()
        if ["md", "markdown", "mdx"].contains(ext) { return .markdown }
        if ["diff", "patch"].contains(ext) || text.hasPrefix("diff --git") { return .diff }
        let head = text.prefix(4000)
        if head.contains("\n--- "), head.contains("\n+++ "), head.contains("\n@@ ") { return .diff }
        return .code
    }
}

extension View {
    /// Paths in this chat resolve against the session's worktree, and a click on one opens it.
    func opensFileLinks(_ sessions: SessionsModel, root: String) -> some View {
        environment(\.worktree, root).environment(\.openURL, FileLinks.action(sessions, root: root))
    }
}
