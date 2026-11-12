import Foundation

/// Render states for the sidebars, the Changes panel's pull request row, the branch menu and archiving
/// (docs/design/sidebar-pr-panel.md, Direction A).
extension SampleSessions {
    /// The ATC-1742 card session with Omar's 15 files (docs/design/sidebar-pr-panel.md), its pull request in one of
    /// the states GitHub gives (nil: no pull request yet).
    static func prScene(_ m: SessionsModel, _ status: Sessions.PullRequest.Status?, unresolved: Int = 0) {
        ChangesPanel.openInRender = nil
        m.selected = "s4"
        guard let i = m.sessions.firstIndex(where: { $0.id == "s4" }) else { return }
        m.sessions[i].title = "ATC-1742 Serve Directory talent page from cached rows"
        m.sessions[i].repo = "andela-technology/andela"
        m.sessions[i].branch = "serve-directory-talent-from-cached-talent-rows-atc-1742"
        m.sessions[i].chats[0].title = "ATC-1742"
        m.sessions[i].status = "review"
        m.sessions[i].prNumber = status == nil ? nil : 1288
        m.sessions[i].prState = status == nil ? nil : "OPEN"
        m.changes["s4"] = [
            .init(path: "app/jobs/persist_work_experience_with_skills_job.rb", added: 3, removed: 1, status: "M"),
            .init(path: "app/jobs/store_extracted_work_experience_job.rb", added: 3, removed: 1, status: "M"),
            .init(path: "app/api/v1/talents/list.rb", added: 4, removed: 27, status: "M"),
            .init(path: "app/queries/talent_list.rb", added: 20, removed: 0, status: "A"),
            .init(path: "app/api/root.rb", added: 4, removed: 0, status: "M"),
            .init(path: "app/models/taxonomy_entry.rb", added: 6, removed: 0, status: "M"),
            .init(path: "app/models/work_experience_skill.rb", added: 24, removed: 0, status: "M"),
            .init(path: "app/services/talent_list.rb", added: 109, removed: 0, status: "A"),
            .init(path: "app/queries/talent_query.rb", added: 0, removed: 122, status: "D"),
            .init(path: "app/services/talent_row_builder.rb", added: 95, removed: 0, status: "A"),
            .init(path: "lib/tasks/talents.rake", added: 26, removed: 0, status: "M"),
            .init(path: "spec/api/v1/talents/list_spec.rb", added: 49, removed: 163, status: "M"),
            .init(path: "spec/requests/talent_list_json_freshness_spec.rb", added: 88, removed: 0, status: "A"),
            .init(path: "spec/queries/talent_query_spec.rb", added: 0, removed: 324, status: "D"),
            .init(path: "frontend/registry.ts", added: 0, removed: 2, status: "M"),
        ]
        guard let status else {
            m.pullRequests["s4"] = nil
            return
        }
        var threads: [String: Int] = [:]
        if unresolved > 0 {
            threads["app/jobs/persist_work_experience_with_skills_job.rb"] = unresolved - 1
            threads["app/models/taxonomy_entry.rb"] = 1
        }
        m.pullRequests["s4"] = Sessions.PullRequest(
            number: 1288, title: "Serve Directory talent page from cached rows", state: "OPEN", url: "https://github.com", isDraft: false,
            checks: [
                .init(name: "rspec (1/4)", state: status.tone == "failing" ? "FAILURE" : "SUCCESS", url: "https://github.com", required: true),
                .init(name: "rubocop", state: status.tone == "failing" ? "FAILURE" : "SUCCESS", url: "https://github.com", required: true),
                .init(name: "brakeman", state: "SUCCESS", url: "https://github.com", required: true),
            ],
            base: "main", unresolved: unresolved, threadsByPath: threads, status: status)
    }

    /// Puts the model in one of this round's states; false when the scene is someone else's.
    static func prPanelScene(_ m: SessionsModel, _ scene: String) -> Bool {
        switch scene {
        case "sessions-pr-ready": prScene(m, .init(tone: "ready", label: "Ready to merge", action: "merge"))
        case "sessions-pr-conflicts": prScene(m, .init(tone: "blocked", label: "Conflicts with main", action: "resolve"), unresolved: 2)
        case "sessions-pr-behind":
            prScene(m, .init(tone: "blocked", label: "Branch is behind main", action: "update"))
            BranchMenu.copiedInRender = true
        case "sessions-pr-failing":
            ChangesPanel.checksOpenInRender = true
            prScene(m, .init(tone: "failing", label: "Checks failing (2 of 3)", action: "view_checks"))
        case "sessions-pr-comments": prScene(m, .init(tone: "blocked", label: "3 review comments", action: "pull_comments"), unresolved: 3)
        case "sessions-pr-checking": prScene(m, .init(tone: "checking", label: "Checking with GitHub…", action: nil))
        case "sessions-pr-running": prScene(m, .init(tone: "waiting", label: "Checks running (1 of 3)", action: nil))
        case "sessions-pr-none": prScene(m, nil)
        case "sessions-sidebars-closed":
            prScene(m, .init(tone: "ready", label: "Ready to merge", action: "merge"))
            m.showSessions = false
            m.showChanges = false
        case "sessions-archive-hover":
            prScene(m, .init(tone: "ready", label: "Ready to merge", action: "merge"))
            SessionList.hoveredInRender = "s2"
        case "sessions-archived", "sessions-archive-ask":
            prScene(m, .init(tone: "ready", label: "Ready to merge", action: "merge"))
            for n in 0..<12 {
                var a = session(
                    "a\(n)", ["Spike: Kimi provider", "Retry the Basecamp token", "Old landing copy"][n % 3], repo: "Donnadieu/forge-desktop",
                    branch: "x\(n)", status: "archived", chats: [])
                a.archived = true
                a.updatedAt = String(format: "2026-11-%02dT10:00:00Z", n + 1)
                m.sessions.append(a)
            }
            m.foldedGroups = ["Idle", "Merged"]
            if scene == "sessions-archive-ask", let card = m.sessions.first(where: { $0.id == "s5" }) {
                var c = card
                c.title = "ATC-1730 Placement jobs close on fill"
                m.archiveAsk = m.archiveQuestion(c) ?? SessionsModel.ArchiveAsk(session: c, title: "Archive ATC-1730?", message: "")
            }
        case "sessions-rename":
            m.selected = "s1"
            if let s = m.sessions.first(where: { $0.id == "s1" }) { m.renameAsk = s }
        default: return false
        }
        return true
    }
}
