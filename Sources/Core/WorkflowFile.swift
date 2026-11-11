import Foundation

/// The workflow file. Only Forge writes it (Omar, Nov 11 2026: hand edits broke too much, so settings come to the
/// screens one control at a time). 0.2.23 to 0.2.32 had an editor; a file someone saved from it carries a mark, and
/// Forge's saves then rewrite only the settings the app owns (`appKeys`) and the app's marked part of the
/// instructions, so what they typed stays. Pure apart from the folder it reads and writes.
struct WorkflowFile {
    let home: URL

    /// Settings the app's screens write. The rest (hooks, turns, timeouts, polling, retry) stays as it is in a
    /// file edited by hand.
    static let appKeys: [String] = [
        "tracker.kind", "tracker.project_slug", "tracker.account_id", "tracker.identity_id", "tracker.card_table_id",
        "tracker.status_field_id", "tracker.columns", "tracker.active_states", "tracker.promote", "board.columns",
        "workspace.root", "workspace.base_branch", "workspace.skills_dir", "agent.kind", "agent.model", "agent.roles",
        "agent.max_concurrent_agents", "marks",
    ]

    /// The app's part of the instructions: the board's notes and the note for stages that are off.
    static let partStart = "<!-- set by the app: edits between these lines are replaced on save -->"
    static let partEnd = "<!-- end of the app's part -->"

    var url: URL { home.appendingPathComponent("WORKFLOW.md") }
    /// Left by the old editor (with the versions it kept, which stay on disk untouched).
    private var editedMark: URL { home.appendingPathComponent("workflow-versions/edited") }

    /// Someone saved this file from the old editor; Forge's saves merge into it.
    var edited: Bool { FileManager.default.fileExists(atPath: editedMark.path) }

    var text: String? { try? String(contentsOf: url, encoding: .utf8) }

    func save(_ new: String) throws {
        try new.write(to: url, atomically: true, encoding: .utf8)
    }

    // MARK: Merging the app's settings into a file edited by hand

    /// `edited` with every app-owned setting and the app's part of the instructions taken from `app`.
    static func merge(edited: String, app: String) -> String {
        let (eFront, eBody) = split(edited)
        let (aFront, aBody) = split(app)
        guard var front = eFront, let appFront = aFront else { return app }
        for key in appKeys {
            let block = YAMLBlocks.block(appFront, key)
            front = YAMLBlocks.set(front, key, block.map { Array(appFront[$0]) })
        }
        return (["---"] + front + ["---"]).joined(separator: "\n") + "\n" + withPart(eBody, from: aBody)
    }

    /// The settings lines (without the --- lines) and the instructions after them.
    static func split(_ text: String) -> (front: [String]?, body: String) {
        let lines = text.components(separatedBy: "\n")
        guard lines.first?.trimmingCharacters(in: .whitespaces) == "---",
            let end = lines.indices.dropFirst().first(where: { lines[$0].trimmingCharacters(in: .whitespaces) == "---" })
        else { return (nil, text) }
        return (Array(lines[1..<end]), lines[(end + 1)...].joined(separator: "\n"))
    }

    static func part(_ body: String) -> String? {
        guard let s = body.range(of: partStart), let e = body.range(of: partEnd, range: s.upperBound..<body.endIndex) else { return nil }
        return String(body[s.lowerBound..<e.upperBound])
    }

    /// `body` with its app part replaced by the one in `app` (added at the top when it was deleted).
    static func withPart(_ body: String, from app: String) -> String {
        guard let new = part(app) else { return body }
        if let s = body.range(of: partStart), let e = body.range(of: partEnd, range: s.upperBound..<body.endIndex) {
            return body.replacingCharacters(in: s.lowerBound..<e.upperBound, with: new)
        }
        return new + "\n" + body
    }
}

/// Finds and replaces one setting's lines in a YAML block written the plain way (two-level keys, block or flow
/// values). Enough for the workflow file's settings; anything fancier is the engine check's to refuse.
enum YAMLBlocks {
    static func indent(_ s: String) -> Int { s.prefix { $0 == " " }.count }
    static func blank(_ s: String) -> Bool { s.trimmingCharacters(in: .whitespaces).isEmpty || s.trimmingCharacters(in: .whitespaces).hasPrefix("#") }

    static func keyOf(_ s: String) -> String? {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard !t.hasPrefix("-"), let colon = t.firstIndex(of: ":") else { return nil }
        let after = t.index(after: colon)
        guard after == t.endIndex || t[after] == " " else { return nil }
        return String(t[..<colon]).trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
    }

    /// The lines of `key` (dotted, e.g. `agent.roles`) and everything nested under it.
    static func block(_ lines: [String], _ key: String, in range: Range<Int>? = nil, minIndent: Int = 0) -> Range<Int>? {
        let parts = key.split(separator: ".", maxSplits: 1).map(String.init)
        let r = range ?? 0..<lines.count
        // The level's indent is its first key's.
        guard let first = r.first(where: { !blank(lines[$0]) && indent(lines[$0]) >= minIndent }) else { return nil }
        let level = indent(lines[first])
        for i in r where !blank(lines[i]) && indent(lines[i]) == level && keyOf(lines[i]) == parts[0] {
            var end = i + 1
            while end < r.upperBound {
                let l = lines[end]
                if !blank(l), indent(l) < level || (indent(l) == level && !l.trimmingCharacters(in: .whitespaces).hasPrefix("-")) { break }
                end += 1
            }
            while end > i + 1, blank(lines[end - 1]) { end -= 1 }
            if parts.count == 1 { return i..<end }
            return block(lines, parts[1], in: (i + 1)..<end, minIndent: level + 1)
        }
        return nil
    }

    /// `lines` with `key` set to `value` (the app's own lines for it), or removed when `value` is nil.
    static func set(_ lines: [String], _ key: String, _ value: [String]?) -> [String] {
        var out = lines
        if let at = block(out, key) {
            guard let value else {
                out.removeSubrange(at)
                return out
            }
            out.replaceSubrange(at, with: reindent(value, to: indent(out[at.lowerBound])))
            return out
        }
        guard let value else { return out }
        let parts = key.split(separator: ".", maxSplits: 1).map(String.init)
        if parts.count == 2 {
            if let parent = block(out, parts[0]) {
                let child = out[parent].dropFirst().first { !blank($0) }.map(indent) ?? (indent(out[parent.lowerBound]) + 2)
                out.insert(contentsOf: reindent(value, to: child), at: parent.upperBound)
            } else {
                out += ["\(parts[0]):"] + reindent(value, to: 2)
            }
        } else {
            out += reindent(value, to: 0)
        }
        return out
    }

    /// `block` moved so its first line sits at `to` spaces, keeping the nesting under it.
    static func reindent(_ block: [String], to: Int) -> [String] {
        guard let first = block.first else { return [] }
        let shift = to - indent(first)
        return block.map { l in
            if shift >= 0 { return String(repeating: " ", count: shift) + l }
            return String(l.dropFirst(min(-shift, indent(l))))
        }
    }
}
