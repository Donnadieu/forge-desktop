import Foundation

extension Checks {
    /// Item 6: skills in sessions. Forge finds them in the repo, ~/.claude/skills, Codex's and its own, reads only
    /// each skill's SKILL.md, keeps them cached until a folder changes, and runs one from the list or "/".
    static func skillChecks(_ check: (String, Bool) -> Void) {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("forge-skills-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: root) }
        let repo = root.appendingPathComponent("repo")
        let home = root.appendingPathComponent("home")
        let codex = home.appendingPathComponent(".codex")
        let bundled = root.appendingPathComponent("bundled")
        func skill(_ dir: URL, _ name: String, _ body: String) {
            let d = dir.appendingPathComponent(name)
            try? fm.createDirectory(at: d, withIntermediateDirectories: true)
            try? body.write(to: d.appendingPathComponent("SKILL.md"), atomically: true, encoding: .utf8)
        }
        skill(
            repo.appendingPathComponent(".claude/skills"), "release-notes",
            "---\nname: release-notes\ndescription: Write the release notes.\n---\n# Notes")
        skill(repo.appendingPathComponent(".agents/skills"), "db-reset", "---\ndescription: \"Reset the dev database.\"\n---\nbody")
        skill(
            home.appendingPathComponent(".claude/skills"), "code-comment-style",
            "---\nname: code-comment-style\ndescription: Comments that explain why.\n---")
        skill(codex.appendingPathComponent("skills"), "triage", "# Triage\n\nSort the inbox by what matters.")
        skill(bundled, "simplify", "---\nname: simplify\ndescription: Make the change smaller.\n---")
        try? "secret".write(to: repo.appendingPathComponent(".claude/skills/NOTES.md"), atomically: true, encoding: .utf8)
        let outside = root.appendingPathComponent("outside.md")
        try? "---\nname: sneaky\n---".write(to: outside, atomically: true, encoding: .utf8)
        let linked = repo.appendingPathComponent(".claude/skills/sneaky")
        try? fm.createDirectory(at: linked, withIntermediateDirectories: true)
        try? fm.createSymbolicLink(at: linked.appendingPathComponent("SKILL.md"), withDestinationURL: outside)

        var reads: [String] = []
        let catalog = SkillCatalog { url in
            reads.append(url.path)
            return try? String(contentsOf: url, encoding: .utf8)
        }
        let roots = SkillCatalog.roots(repo: repo.path, home: home.path, codexHome: codex.path, bundled: bundled.path)
        let found = catalog.list(roots)
        check(
            "skills are found in the repo, ~/.claude/skills, Codex's and Forge's own",
            Set(found.map(\.name)) == ["release-notes", "db-reset", "code-comment-style", "triage", "simplify"])
        check("a skill's description comes from its front matter", found.first { $0.name == "db-reset" }?.summary == "Reset the dev database.")
        check(
            "without front matter, the folder names it and its first line describes it",
            found.first { $0.name == "triage" }?.summary == "Sort the inbox by what matters.")
        check(
            "each skill says where it's from",
            found.first { $0.name == "triage" }?.source == .codex && found.first { $0.name == "simplify" }?.source == .forge)
        check("only SKILL.md files inside skill folders are read", !reads.isEmpty && reads.allSatisfy { $0.hasSuffix("/SKILL.md") })
        check("a SKILL.md that points outside its folder is never read", !reads.contains(outside.path) && !found.contains { $0.name == "sneaky" })
        let before = reads.count
        _ = catalog.list(roots)
        check("the list is cached: nothing is read again while nothing changed", reads.count == before)
        Thread.sleep(forTimeInterval: 1.1)
        skill(bundled, "commit", "---\nname: commit\ndescription: One commit per change.\n---")
        let again = catalog.list(roots)
        check("a new skill in a folder is picked up", again.contains { $0.name == "commit" })
        check("only the folder that changed is read again", reads.count - before == 2)
        check("search matches names and descriptions", SkillCatalog.filter(again, "database").map(\.name) == ["db-reset"])
        check("an empty search lists every skill", SkillCatalog.filter(again, "").count == again.count)
        let notes = again.first { $0.name == "release-notes" }
        check("a skill Claude Code sees itself runs as a slash command", notes?.message == "/release-notes")
        let codexSkill = again.first { $0.name == "triage" }
        check(
            "any other skill is run by asking the agent to follow its SKILL.md",
            codexSkill?.message == "Use the triage skill: read \(codex.path)/skills/triage/SKILL.md and follow it.")
        check("typing / at the start opens the list", SkillCatalog.slashQuery("/") == "" && SkillCatalog.slashQuery("/sim") == "sim")
        check("a slash inside a message doesn't", SkillCatalog.slashQuery("see /tmp") == nil && SkillCatalog.slashQuery("/sim more words") == nil)
    }
}
