import Foundation

/// A skill a session can run: a folder with a SKILL.md, from the repo, the person's Claude Code or Codex skills,
/// or Forge's own stage skills.
struct Skill: Equatable, Sendable, Identifiable {
    enum Source: String, Sendable {
        case repo, claude, codex, forge

        /// Where it's from, as the list says it.
        var label: String {
            switch self {
            case .repo: return "This repo"
            case .claude: return "Your Claude Code"
            case .codex: return "Your Codex"
            case .forge: return "Forge"
            }
        }
    }

    let name: String
    let summary: String
    let source: Source
    /// The skill's SKILL.md.
    let file: String
    /// Claude Code finds this one by itself (the repo's `.claude/skills`, `~/.claude/skills`), so `/name` runs it.
    let claudeSees: Bool
    var id: String { "\(source.rawValue)/\(name)" }

    /// What the session sends to run it.
    var message: String {
        claudeSees ? "/\(name)" : "Use the \(name) skill: read \(file) and follow it."
    }
}

/// Finds skills and keeps them until a folder changes. Reads nothing but `<folder>/<skill>/SKILL.md`, and only
/// when that file is a plain file inside the skill's folder (never a link out of it).
final class SkillCatalog: @unchecked Sendable {
    struct Root: Equatable, Sendable {
        let path: String
        let source: Skill.Source
        let claudeSees: Bool
    }

    /// What one folder held the last time it was read, and the dates that say whether it changed since.
    private struct Seen {
        var stamp: [String: Date]
        var skills: [Skill]
    }

    private let read: (URL) -> String?
    private var seen: [String: Seen] = [:]
    private let lock = NSLock()

    init(read: @escaping (URL) -> String? = { try? String(contentsOf: $0, encoding: .utf8) }) {
        self.read = read
    }

    /// The folders, in the order a name wins: the repo's, the person's Claude Code, Codex, then Forge's own.
    static func roots(repo: String?, home: String, codexHome: String?, bundled: String?) -> [Root] {
        var roots: [Root] = []
        if let repo {
            roots += [
                Root(path: repo + "/.claude/skills", source: .repo, claudeSees: true),
                Root(path: repo + "/.agents/skills", source: .repo, claudeSees: false),
                Root(path: repo + "/.codex/skills", source: .repo, claudeSees: false),
                Root(path: repo + "/.cursor/skills", source: .repo, claudeSees: false),
                Root(path: repo + "/skills", source: .repo, claudeSees: false),
            ]
        }
        roots.append(Root(path: home + "/.claude/skills", source: .claude, claudeSees: true))
        roots.append(Root(path: (codexHome ?? home + "/.codex") + "/skills", source: .codex, claudeSees: false))
        if let bundled { roots.append(Root(path: bundled, source: .forge, claudeSees: false)) }
        return roots
    }

    /// The roots for a session's folder on this Mac.
    static func roots(sessionFolder: String?) -> [Root] {
        let env = ProcessInfo.processInfo.environment
        return roots(
            repo: sessionFolder, home: FileManager.default.homeDirectoryForCurrentUser.path, codexHome: env["CODEX_HOME"],
            bundled: Bundle.main.resourceURL?.appendingPathComponent("engine/skills").path)
    }

    /// Every skill in these folders, one per name (the first folder wins), sorted by name.
    func list(_ roots: [Root]) -> [Skill] {
        lock.lock()
        defer { lock.unlock() }
        var names = Set<String>()
        var all: [Skill] = []
        for root in roots {
            for s in skills(in: root) where names.insert(s.name).inserted { all.append(s) }
        }
        return all.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private func skills(in root: Root) -> [Skill] {
        let stamp = Self.stamp(root.path)
        if let s = seen[root.path], s.stamp == stamp { return s.skills }
        var found: [Skill] = []
        for entry in stamp.keys.sorted() where entry != "." {
            let file = URL(fileURLWithPath: root.path).appendingPathComponent(entry).appendingPathComponent("SKILL.md")
            guard let text = read(file) else { continue }
            let (name, summary) = Self.parse(text, folder: entry)
            found.append(Skill(name: name, summary: summary, source: root.source, file: file.path, claudeSees: root.claudeSees))
        }
        seen[root.path] = Seen(stamp: stamp, skills: found)
        return found
    }

    /// The folder's own date and each skill's SKILL.md date: a new, removed or edited skill changes it. Only skills
    /// whose SKILL.md is a plain file (not a link) are counted, so nothing outside a skill's folder is ever opened.
    private static func stamp(_ path: String) -> [String: Date] {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(atPath: path) else { return [:] }
        var stamp: [String: Date] = [".": (try? fm.attributesOfItem(atPath: path)[.modificationDate] as? Date) ?? .distantPast]
        for e in entries where !e.hasPrefix(".") {
            let file = path + "/" + e + "/SKILL.md"
            guard let a = try? fm.attributesOfItem(atPath: file), a[.type] as? FileAttributeType == .typeRegular else { continue }
            stamp[e] = a[.modificationDate] as? Date ?? .distantPast
        }
        return stamp
    }

    /// Name and one line from the SKILL.md: its front matter, else the folder's name and the first plain line.
    static func parse(_ text: String, folder: String) -> (String, String) {
        var name = folder
        var summary = ""
        var body = Substring(text)
        if text.hasPrefix("---"), let end = text.range(of: "\n---", range: text.index(text.startIndex, offsetBy: 3)..<text.endIndex) {
            for line in text[text.index(text.startIndex, offsetBy: 3)..<end.lowerBound].split(separator: "\n") {
                let parts = line.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
                guard parts.count == 2 else { continue }
                let value = parts[1].trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
                if parts[0] == "name", !value.isEmpty { name = value }
                if parts[0] == "description" { summary = value }
            }
            body = text[end.upperBound...]
        }
        if summary.isEmpty {
            summary = body.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty && !$0.hasPrefix("#") } ?? ""
        }
        return (name, summary)
    }

    /// Skills whose name or description has every word of the search.
    static func filter(_ skills: [Skill], _ query: String) -> [Skill] {
        let words = query.lowercased().split(separator: " ")
        guard !words.isEmpty else { return skills }
        return skills.filter { s in
            let hay = (s.name + " " + s.summary).lowercased()
            return words.allSatisfy { hay.contains($0) }
        }
    }

    /// What's typed after a "/" that starts the message box (the list opens, filtered by it); nil otherwise.
    static func slashQuery(_ text: String) -> String? {
        guard text.hasPrefix("/") else { return nil }
        let rest = text.dropFirst()
        return rest.contains(where: \.isWhitespace) ? nil : String(rest)
    }
}
