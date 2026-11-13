import SwiftUI

/// The left list: search, New session, then the sessions grouped by what they need from you (idle, merged and
/// archived groups start folded, so the list stays tidy), and Import from Conductor at the bottom. Hovering a row
/// shows Archive (Unarchive on an archived one, never Archive again); right-click opens it beside the one on screen.
/// An archived row opens its session read-only.
struct SessionList: View {
    @ObservedObject var model: AppModel
    @ObservedObject var sessions: SessionsModel
    let list: [Sessions.Session]
    @State private var search = ""
    @State private var hovered: String? = SessionList.hoveredInRender

    /// A row a render draws hovered (`--render-screens` can't hover).
    @MainActor static var hoveredInRender: String?

    static let groups: [(status: [String], title: String)] = [
        (["needs_you"], "Needs you"), (["working"], "Working"), (["review"], "Ready for review"), (["idle"], "Idle"), (["merged"], "Merged"),
    ]
    static let archivedTitle = "Archived"
    /// The Archived group lists this many (newest first); History has the rest.
    static let archivedShown = 20

    struct Section: Identifiable {
        let title: String
        /// How many sessions the group holds (shown on its header, folded or not).
        let count: Int
        let folded: Bool
        let rows: [Sessions.Session]
        var id: String { title }
        var archived: Bool { title == SessionList.archivedTitle }
    }

    static func matching(_ list: [Sessions.Session], _ search: String) -> [Sessions.Session] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return list }
        return list.filter { ($0.title + " " + $0.repo + " " + $0.branch + " " + ($0.prTitle ?? "")).lowercased().contains(q) }
    }

    /// The list's groups in order, archived sessions last. A folded group shows only its header (and the session on
    /// screen, if it's in there); a search opens every group so matches are never hidden.
    static func sections(
        _ list: [Sessions.Session], archived: [Sessions.Session] = [], folded: Set<String>, search: String, selected: String?
    ) -> [Section] {
        let found = matching(list, search)
        let searching = !search.trimmingCharacters(in: .whitespaces).isEmpty
        var out: [Section] = groups.compactMap { g in
            let all = found.filter { g.status.contains($0.status) }
            guard !all.isEmpty else { return nil }
            let fold = folded.contains(g.title) && !searching
            return Section(title: g.title, count: all.count, folded: fold, rows: fold ? all.filter { $0.id == selected } : all)
        }
        let old = matching(archived, search).sorted { $0.updatedAt > $1.updatedAt }
        if !old.isEmpty {
            let fold = folded.contains(archivedTitle) && !searching
            out.append(Section(title: archivedTitle, count: old.count, folded: fold, rows: fold ? [] : Array(old.prefix(archivedShown))))
        }
        return out
    }

    private var shown: [Sessions.Session] { Self.matching(list, search) }
    private var archived: [Sessions.Session] { sessions.archived(in: model.workspace?.id) }

    var body: some View {
        VStack(spacing: 0) {
            PaneHeader(alignment: .center) { top }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Self.sections(list, archived: archived, folded: sessions.foldedGroups, search: search, selected: sessions.selected)) {
                        g in
                        header(g)
                        // A row is keyed by its group too: a session that moves group (archived, back) gets a new
                        // row, never the old one's hover button, menu and click (Omar, Nov 13: an archived row still
                        // offered Archive).
                        ForEach(g.rows) { s in row(s, archived: s.archived).id("\(g.title)/\(s.id)") }
                        if g.archived, !g.folded, g.count > Self.archivedShown {
                            Button("Show all \(g.count) in History") { sessions.showHistory = true }
                                .buttonStyle(ForgeButton(kind: .plain)).padding(.horizontal, 20).padding(.vertical, 6)
                        }
                    }
                    if shown.isEmpty, archived.isEmpty || !search.isEmpty {
                        Text(list.isEmpty ? "No sessions yet. Start one, or bring your Conductor work over." : "Nothing matches.")
                            .font(Theme.sans(.small)).foregroundStyle(Theme.textMuted).padding(16)
                    }
                }
            }
            Rectangle().fill(Theme.border).frame(height: 1)
            Button {
                sessions.showHistory = true
            } label: {
                Label("History", systemImage: "clock.arrow.circlepath").font(Theme.sans(.small)).foregroundStyle(Theme.textSec)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 20).frame(height: 40)
            Button {
                sessions.openImport(repo: model.sessionRepos.first?.repo)
            } label: {
                Label("Import from Conductor", systemImage: "square.and.arrow.down").font(Theme.sans(.small)).foregroundStyle(Theme.textSec)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 20).frame(height: 48)
        }
        .background(Theme.bg.opacity(0.6))
    }

    /// Search and New session, in the pane's header.
    private var top: some View {
        VStack(spacing: 8) {
            TextField("", text: $search).forgeField(hint: "Search sessions", empty: search.isEmpty, icon: "magnifyingglass")
            Button {
                sessions.composing = true
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "plus").font(Theme.icon(.glyphM, .medium))
                    Text("New session").font(Theme.sans(.small, .semibold))
                    KeyHint(text: "⌘N", onAmber: true)
                }
                .foregroundStyle(Theme.bg)
                .frame(maxWidth: .infinity).frame(height: 36)
                .background(RoundedRectangle(cornerRadius: Theme.rLg).fill(Theme.heat))
                .overlay(RoundedRectangle(cornerRadius: Theme.rLg).stroke(Theme.heatBorder))
                .shadow(color: Theme.heatGlow, radius: 12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
    }

    /// A group's header: its name and count; a click folds or opens it.
    private func header(_ g: Section) -> some View {
        Button {
            withAnimation(.easeOut(duration: 0.15)) { sessions.toggleGroup(g.title) }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: g.folded ? "chevron.right" : "chevron.down").font(Theme.icon(.glyphTiny, .bold))
                    .foregroundStyle(Theme.textMuted).frame(width: 10)
                SectionLabel(text: g.title)
                Text("\(g.count)").font(Theme.mono(.label)).foregroundStyle(Theme.textMuted)
                Spacer()
            }
            .padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(g.folded ? "Show the \(g.count) \(g.title.lowercased()) sessions" : "Fold this group")
    }

    /// A row's look. Only the open session is highlighted; a hovered row gets a fainter wash of its own; a row's
    /// state (working, idle, failed) shows in its dot and its group, never as a fill.
    enum Look: Equatable {
        case open, hovered, plain

        var fill: Color {
            switch self {
            case .open: return Theme.surfaceHover
            case .hovered: return Theme.surface.opacity(0.45)
            case .plain: return .clear
            }
        }

        var edge: Color { self == .open ? Theme.border : .clear }
    }

    static func look(open: Bool, hovered: Bool) -> Look { open ? .open : hovered ? .hovered : .plain }

    private func dot(_ s: Sessions.Session) -> Color {
        switch s.status {
        case "needs_you", "working": return Theme.heat
        case "merged": return Theme.good
        default: return Theme.textSec
        }
    }

    private func row(_ s: Sessions.Session, archived: Bool) -> some View {
        let on = sessions.selected == s.id && !sessions.composing
        let hover = hovered == s.id
        return HStack(alignment: .top, spacing: 8) {
            PulseDot(color: archived ? Theme.textMuted : dot(s), pulsing: !archived && s.status == "working", size: 6).padding(.top, 6)
            VStack(alignment: .leading, spacing: 2) {
                Text(s.title).font(Theme.sans(.body, .medium)).foregroundStyle(archived ? Theme.textSec : Theme.text).lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(s.prNumber.map { "\(s.repo) · PR #\($0)" } ?? "\(s.repo) · \(s.branch)")
                    .font(Theme.mono(.label)).foregroundStyle(Theme.textMuted).lineLimit(1)
                if !archived {
                    HStack(spacing: 4) {
                        if s.origin == "card" { AnvilMark().sized(11) }
                        Text(s.origins).font(Theme.sans(.caption)).foregroundStyle(Theme.textMuted)
                    }
                }
            }
            ZStack(alignment: .topTrailing) {
                if hover {
                    Button {
                        if archived { sessions.restore(s) } else { sessions.requestArchive(s) }
                    } label: {
                        Image(systemName: archived ? "arrow.uturn.backward" : "archivebox").font(Theme.icon(.glyph))
                            .foregroundStyle(Theme.textSec).frame(width: 22, height: 22)
                            .background(RoundedRectangle(cornerRadius: Theme.rSm).fill(Theme.surfaceRaised.opacity(0.6)))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(archived ? "Unarchive \(s.title)" : "Archive \(s.title)")
                } else if s.unread, !archived {
                    Circle().fill(Theme.text).frame(width: 5, height: 5).padding(.top, 6)
                }
            }
            .frame(width: 22)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(Self.look(open: on, hovered: hover).fill))
        .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Self.look(open: on, hovered: hover).edge))
        .opacity(archived && !hover ? 0.7 : 1)
        .contentShape(Rectangle())
        .onTapGesture { sessions.open(s) }
        .onHover { inside in
            if inside { hovered = s.id } else if hovered == s.id { hovered = nil }
        }
        .padding(.horizontal, 8)
        .contextMenu {
            if archived {
                Button("Unarchive") { sessions.restore(s) }
            } else {
                if let c = s.chats.first, sessions.selected != nil, sessions.selected != s.id {
                    Button("Open beside this one") { sessions.splitChat = c.id }
                }
                Button("Archive") { sessions.requestArchive(s) }
            }
        }
    }
}
