import Foundation

/// Omar's ATC-1742 review summary (Nov 11): a GFM table and two paths into the card's worktree. The render scenes
/// `sessions-review-summary` (the chat) and `sessions-file-*` (a path opened in the file viewer) use it.
enum SampleReview {
    static let diffPath = "tmp/git-diffs/serve-directory-talent-from-cached-talent-rows-atc-1742-diff-1.txt"
    static let reviewPath = "tmp/code-reviews/serve-directory-talent-from-cached-talent-rows-atc-1742-nuclear-review.md"

    static let summary = """
        Nuclear code review complete: behavioral + structural.

        📄 Diff: `\(diffPath)`
        📄 Review: `\(reviewPath)`

        Branch rebased cleanly onto `main` (580c102) first. 36 files, 3477 lines.

        | Lane | Critical | High | Medium | Low |
        |------|----------|------|--------|-----|
        | Behavioral (B) | 1 | 10 | 19 | 18 |
        | Structural (T) | 2 | 10 | 12 | 8 |
        | **Total (deduped)** | **3** | **19** | **29** | **20** |

        ### Top critical issues

        1. **C1** `[B]` A cold or rotated cache rebuilds the whole bucket synchronously inside one HTTP request, with no bound, no single-flight and no fallback.
        2. **C2** `[both lanes]` A skill is stored as its position in `TaxonomyEntry.ordered_by_sequence`, inside a cached row.
        3. **C3** `[T]` `TalentList`, `talents.rake` and half of `TalentRowBuilder` are verbatim forks of the sourcing equivalents.

        ### Next steps

        - [x] Behavioral lane
        - [x] Structural lane
        - [ ] Fix C1 to C3
          - ~~Drop the cache~~ keep it, add single-flight
        """

    static let review = """
        # Nuclear review: ATC-1742

        | Lane | Critical | High |
        |:-----|:--------:|-----:|
        | Behavioral | 1 | 10 |
        | Structural | 2 | 10 |

        ## C1: cold cache rebuilds in one request

        `TalentQuery` was deleted in the same commit, so a cold cache falls through to a full rebuild.

        - [ ] Bound the rebuild
        - [ ] Add single-flight
        """

    static let diff = """
        diff --git a/backend/app/models/talent_row_builder.rb b/backend/app/models/talent_row_builder.rb
        index 3f1c2a9..8be41d0 100644
        --- a/backend/app/models/talent_row_builder.rb
        +++ b/backend/app/models/talent_row_builder.rb
        @@ -12,6 +12,9 @@ class TalentRowBuilder
           KEYS = %i[id name skills].freeze
        -  def self.build(talent)
        -    new(talent).row
        +  # Rows are cached per taxonomy fingerprint.
        +  def self.build(talent, taxonomy: Taxonomy.fingerprint)
        +    Rails.cache.fetch([NAMESPACE, taxonomy, talent.id]) { new(talent).row }
           end
        diff --git a/backend/lib/tasks/talents.rake b/backend/lib/tasks/talents.rake
        index 1d0a7e2..44c9f10 100644
        --- a/backend/lib/tasks/talents.rake
        +++ b/backend/lib/tasks/talents.rake
        @@ -1,3 +1,4 @@
         namespace :talents do
        +  desc "Warm the talent rows cache"
           task warm: :environment do
        """

    /// A scratch worktree holding the two files the summary names, so their paths resolve and turn into links.
    static func worktree() -> String {
        let root = (NSTemporaryDirectory() as NSString).appendingPathComponent("forge-sample-worktree-atc-1742")
        let fm = FileManager.default
        for (path, body) in [(diffPath, diff), (reviewPath, review)] {
            let url = URL(fileURLWithPath: root).appendingPathComponent(path)
            try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? body.write(to: url, atomically: true, encoding: .utf8)
        }
        return root
    }
}
