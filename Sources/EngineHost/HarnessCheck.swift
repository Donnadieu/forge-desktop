import Foundation

/// Brings a repo's harness engineering record up to date from GitHub, through the person's `gh` sign-in:
/// - with a card: finds its pull request (the card's identifier is in the PR's branch or title) and whether
///   it merged; a merged one lands the card's guardrails, a closed one frees them to be picked again;
/// - with no record yet: a merged pull request titled "… ready for agents" means the repo is done; otherwise
///   it lists the repo's top folder and notes an agent guide (AGENTS.md) or a pre-commit hook, which reads
///   as partly done. Two small GitHub calls at most; nothing is cloned.
enum HarnessCheck {
    struct PullRequest: Decodable {
        let number: Int
        let state: String
        let title: String
        let headRefName: String
    }

    static func refresh(repo: String, record: HarnessRecord?) async -> HarnessRecord? {
        var r = record ?? HarnessRecord()
        if let card = r.card, r.merged != true {
            guard let prs = await pullRequests(repo) else { return record }
            if let pr = match(card: card, in: prs) {
                switch pr.state {
                case "MERGED": r.landed(pr: pr.number)
                case "CLOSED": r.closed(pr: pr.number)
                default: r.pr = pr.number
                }
            }
            return r
        }
        guard r.assessed != true, r.card == nil else { return record }
        if let pr = await pullRequests(repo)?.first(where: { $0.state == "MERGED" && $0.title.lowercased().contains("ready for agents") }) {
            r.pr = pr.number
            r.merged = true
            return r
        }
        if let found = await foundInRepo(repo) { r.found = found }
        return r
    }

    /// The card's pull request: its identifier (ENG-12) in the branch name or the title, newest first. The
    /// number must end there, so ENG-2 doesn't match a branch for ENG-20.
    static func match(card: String, in prs: [PullRequest]) -> PullRequest? {
        let id = NSRegularExpression.escapedPattern(for: card.lowercased())
        guard let re = try? NSRegularExpression(pattern: "(?<![a-z0-9])\(id)(?![0-9])") else { return nil }
        func has(_ s: String) -> Bool { re.firstMatch(in: s.lowercased(), range: NSRange(location: 0, length: s.utf16.count)) != nil }
        return prs.first { has($0.headRefName) || has($0.title) }
    }

    private static func pullRequests(_ repo: String) async -> [PullRequest]? {
        let r = await GitHub.gh(
            ["pr", "list", "-R", repo, "--state", "all", "--limit", "100", "--json", "number,state,title,headRefName"], timeout: 30)
        guard r.ok else { return nil }
        return try? JSONDecoder().decode([PullRequest].self, from: Data(r.out.utf8))
    }

    /// What harness engineering adds that's already in the repo's top folder.
    private static func foundInRepo(_ repo: String) async -> [String]? {
        let r = await GitHub.gh(["api", "repos/\(repo)/contents", "--jq", ".[].name"], timeout: 30)
        guard r.ok else { return nil }
        let names = Set(r.out.split(separator: "\n").map(String.init))
        return found(names)
    }

    /// Pure: the top-folder names that show harness engineering was (partly) done.
    static func found(_ names: Set<String>) -> [String] {
        var out: [String] = []
        if names.contains("AGENTS.md") { out.append("an agent guide (AGENTS.md)") }
        if !names.isDisjoint(with: [".githooks", ".husky", ".pre-commit-config.yaml", "lefthook.yml", ".lefthook.yml"]) {
            out.append("a pre-commit hook")
        }
        return out
    }
}
