import SwiftUI

/// The "Skills" button by the message box. The composer opens the list: the skills this session can run (the
/// repo's, your Claude Code and Codex skills, Forge's own), with a search; clicking one runs it. "/" opens it too.
struct SkillsButton: View {
    @Binding var open: Bool

    var body: some View {
        Button {
            open.toggle()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "sparkles").font(.system(size: 11, weight: .medium))
                Text("Skills").font(Theme.sans(12, .medium))
            }
            .foregroundStyle(Theme.textSec)
            .padding(.horizontal, 10).frame(height: 30)
            .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.border))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Run a skill in this session")
    }
}

/// The list: a search box (or the words after "/"), then each skill's name, where it's from and its one line.
struct SkillList: View {
    let skills: [Skill]
    /// The words after "/" in the message box; nil = the list has its own search box.
    let query: String?
    let pick: (Skill) -> Void
    @State private var search = ""

    private var shown: [Skill] { SkillCatalog.filter(skills, query ?? search) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if query == nil {
                TextField("", text: $search).textFieldStyle(.plain).font(Theme.sans(13))
                    .forgeField(hint: "Search skills", empty: search.isEmpty, icon: "magnifyingglass")
                    .padding(10)
            } else {
                SectionLabel(text: "Skills").padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 4)
            }
            if shown.isEmpty {
                Text(skills.isEmpty ? "No skills found for this session." : "No skill matches that.")
                    .font(Theme.sans(12)).foregroundStyle(Theme.textMuted).padding(14)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(shown) { s in
                        Button {
                            pick(s)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 8) {
                                    Text(s.name).font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
                                    Chip(text: s.source.label, tone: .quiet)
                                    Spacer(minLength: 0)
                                }
                                if !s.summary.isEmpty {
                                    Text(s.summary).font(Theme.sans(12)).foregroundStyle(Theme.textSec).lineLimit(2)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .frame(maxHeight: 340)
        }
        .padding(.bottom, 6)
        .frame(width: 360)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.surface)
    }
}

extension SampleSessions {
    /// What render mode lists under Skills.
    static let skills: [Skill] = [
        Skill(
            name: "code-comment-style", summary: "Comments that explain why, not what.", source: .claude,
            file: "~/.claude/skills/code-comment-style/SKILL.md", claudeSees: true),
        Skill(
            name: "code-review", summary: "Review the pull request and fix what it finds.", source: .forge,
            file: "engine/skills/code-review/SKILL.md", claudeSees: false),
        Skill(
            name: "commit", summary: "One clean commit per change, in the repo's style.", source: .forge, file: "engine/skills/commit/SKILL.md",
            claudeSees: false),
        Skill(
            name: "db-reset", summary: "Reset the dev database and load the seed data.", source: .repo, file: ".agents/skills/db-reset/SKILL.md",
            claudeSees: false),
        Skill(
            name: "qa-plan", summary: "Test the change the way a person would.", source: .forge, file: "engine/skills/qa-plan/SKILL.md",
            claudeSees: false),
        Skill(
            name: "release-notes", summary: "Write the release notes from the merged pull requests.", source: .repo,
            file: ".claude/skills/release-notes/SKILL.md", claudeSees: true),
        Skill(
            name: "triage", summary: "Sort new cards by what matters first.", source: .codex, file: "~/.codex/skills/triage/SKILL.md",
            claudeSees: false),
    ]
}
