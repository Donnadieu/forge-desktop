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
        /// A path to nothing in the worktree (missing, a folder, or outside it): the viewer says so, nothing opens.
        case missing(URL)
        /// A web (or mail) link: the default browser.
        case web(URL)
    }

    /// A file open in the viewer, and the worktree its links resolve against.
    struct Opened: Equatable {
        var url: URL
        var root: String
        /// The link named no file in the worktree: the viewer says so instead of opening anything.
        var missing = false
    }

    /// Where a web link goes: the default browser. The only way out of the chat to another app; checks swap it to
    /// see what would have opened.
    static var openInBrowser: (URL) -> Void = { NSWorkspace.shared.open($0) }

    /// Path-looking words: letters, digits and `_ . / ~ @ + -`, with an optional `:line` or `:line:column`.
    private static let token = try? NSRegularExpression(pattern: #"[A-Za-z0-9_./~@+\-]+(?::[0-9]+){0,2}"#)
    private static let lineSuffix = try? NSRegularExpression(pattern: #"(?::[0-9]+){1,2}$"#)
    private static let trailing = ".,;:)]'\""

    /// The file a path names inside the worktree, or nil when it doesn't exist, is a folder, or lies outside it.
    /// `named` is for a link's target, which is a path by construction (`Makefile`, `README`): no path-looking test.
    static func resolve(_ token: String, root: String?, named: Bool = false) -> URL? {
        guard let root, !root.isEmpty else { return nil }
        var t = token.trimmingCharacters(in: .whitespacesAndNewlines)
        while let last = t.last, trailing.contains(last) { t.removeLast() }
        if let re = lineSuffix { t = re.stringByReplacingMatches(in: t, range: NSRange(t.startIndex..., in: t), withTemplate: "") }
        if t.hasPrefix("./") { t.removeFirst(2) }
        guard !t.isEmpty, t.count < 1024, !t.hasPrefix("~"), !t.contains("\n"), named || t.contains("/") || t.dropFirst().contains(".") else {
            return nil
        }
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

    /// The path a link names: a file:// URL, or a Markdown link written as a path (`tmp/x.md`, `/Users/…%20…/x.md`),
    /// which has no scheme. Nil for a web link.
    static func path(of url: URL) -> String? {
        if url.isFileURL { return url.path }
        guard url.scheme != nil else { return url.path }
        // `README.md:12` reads as the scheme "README.md": a path with a line number, not an app's link.
        let s = url.absoluteString
        return s.range(of: #"^[^:/]+\.[A-Za-z0-9]+(?::[0-9]+){1,2}$"#, options: .regularExpression) != nil ? s.removingPercentEncoding : nil
    }

    /// What a click on a link does. Every path goes to Forge (the viewer, or its "not found" note); only a link with a
    /// scheme of its own (https, mailto) leaves for another app. Nil for a link to nothing (`#top`).
    static func open(_ url: URL, root: String?, command: Bool) -> Open? {
        guard let path = path(of: url) else { return .web(url) }
        guard !path.isEmpty else { return nil }
        guard let file = resolve(path, root: root, named: true) else {
            let base = URL(fileURLWithPath: root ?? "/")
            return .missing((path.hasPrefix("/") ? URL(fileURLWithPath: path) : base.appendingPathComponent(path)).standardizedFileURL)
        }
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

    /// Follows a link in the chat: a file in the worktree opens in the viewer (Cmd-click: Finder), any other path
    /// shows the viewer's "not found" note, and a web link goes to the browser. Never hands a path to the system:
    /// macOS answers a link with no scheme with "The application can't be opened. -50".
    static func action(_ sessions: SessionsModel, root: String) -> OpenURLAction {
        OpenURLAction { url in
            switch open(url, root: root, command: NSEvent.modifierFlags.contains(.command)) {
            case .view(let file)?:
                sessions.openFile = Opened(url: file, root: root)
            case .reveal(let file)?:
                NSWorkspace.shared.activateFileViewerSelecting([file])
            case .missing(let file)?:
                sessions.openFile = Opened(url: file, root: root, missing: true)
            case .web(let link)?:
                openInBrowser(link)
            case nil:
                break
            }
            return .handled
        }
    }

    /// Links outside a session (a card's workpad): web links go to the browser; a path, with no worktree to find it
    /// in, opens nothing.
    static let webOnly = OpenURLAction { url in
        if case .web(let link)? = open(url, root: nil, command: false) { openInBrowser(link) }
        return .handled
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
