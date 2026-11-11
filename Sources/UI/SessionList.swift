import SwiftUI

/// The left list: search, New session, then the sessions grouped by what they need from you (idle and merged groups
/// start folded, so the list stays tidy), and Import from Conductor at the bottom. Right-click a row to open it beside the one on screen or to archive it.
struct SessionList: View {
    @ObservedObject var model: AppModel
    @ObservedObject var sessions: SessionsModel
    let list: [Sessions.Session]
    @State private var search = ""

    static let groups: [(status: [String], title: String)] = [
        (["needs_you"], "Needs you"), (["working"], "Working"), (["review"], "Ready for review"), (["idle"], "Idle"), (["merged"], "Merged"),
    ]

    struct Section: Identifiable {
        let title: String
        /// How many sessions the group holds (shown on its header, folded or not).
        let count: Int
        let folded: Bool
        let rows: [Sessions.Session]
        var id: String { title }
    }

    static func matching(_ list: [Sessions.Session], _ search: String) -> [Sessions.Session] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return list }
        return list.filter { ($0.title + " " + $0.repo + " " + $0.branch + " " + ($0.prTitle ?? "")).lowercased().contains(q) }
    }

    /// The list's groups in order. A folded group shows only its header (and the session on screen, if it's in
    /// there); a search opens every group so matches are never hidden.
    static func sections(_ list: [Sessions.Session], folded: Set<String>, search: String, selected: String?) -> [Section] {
        let found = matching(list, search)
        let searching = !search.trimmingCharacters(in: .whitespaces).isEmpty
        return groups.compactMap { g in
            let all = found.filter { g.status.contains($0.status) }
            guard !all.isEmpty else { return nil }
            let fold = folded.contains(g.title) && !searching
            return Section(title: g.title, count: all.count, folded: fold, rows: fold ? all.filter { $0.id == selected } : all)
        }
    }

    private var shown: [Sessions.Session] { Self.matching(list, search) }

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 8) {
                TextField("", text: $search).forgeField(hint: "Search sessions", empty: search.isEmpty, icon: "magnifyingglass")
                Button {
                    sessions.composing = true
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "plus").font(.system(size: 12, weight: .medium))
                        Text("New session").font(Theme.sans(12, .semibold))
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
            .padding(12)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Self.sections(list, folded: sessions.foldedGroups, search: search, selected: sessions.selected)) { g in
                        header(g)
                        ForEach(g.rows) { s in row(s) }
                    }
                    if shown.isEmpty {
                        Text(list.isEmpty ? "No sessions yet. Start one, or bring your Conductor work over." : "Nothing matches.")
                            .font(Theme.sans(12)).foregroundStyle(Theme.textMuted).padding(16)
                    }
                }
            }
            Rectangle().fill(Theme.border).frame(height: 1)
            Button {
                sessions.showHistory = true
            } label: {
                Label("History", systemImage: "clock.arrow.circlepath").font(Theme.sans(12)).foregroundStyle(Theme.textSec)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 20).frame(height: 40)
            Button {
                sessions.openImport()
            } label: {
                Label("Import from Conductor", systemImage: "square.and.arrow.down").font(Theme.sans(12)).foregroundStyle(Theme.textSec)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 20).frame(height: 48)
        }
        .background(Theme.bg.opacity(0.6))
    }

    /// A group's header: its name and count; a click folds or opens it.
    private func header(_ g: Section) -> some View {
        Button {
            withAnimation(.easeOut(duration: 0.15)) { sessions.toggleGroup(g.title) }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: g.folded ? "chevron.right" : "chevron.down").font(.system(size: 8, weight: .bold))
                    .foregroundStyle(Theme.textMuted).frame(width: 10)
                SectionLabel(text: g.title)
                Text("\(g.count)").font(Theme.mono(10)).foregroundStyle(Theme.textMuted)
                Spacer()
            }
            .padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(g.folded ? "Show the \(g.count) \(g.title.lowercased()) sessions" : "Fold this group")
    }

    private func dot(_ s: Sessions.Session) -> Color {
        switch s.status {
        case "needs_you", "working": return Theme.heat
        case "merged": return Theme.good
        default: return Theme.textSec
        }
    }

    private func row(_ s: Sessions.Session) -> some View {
        let on = sessions.selected == s.id && !sessions.composing
        return Button {
            sessions.open(s)
        } label: {
            HStack(alignment: .top, spacing: 8) {
                PulseDot(color: dot(s), pulsing: s.status == "working", size: 6).padding(.top, 6)
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(s.title).font(Theme.sans(13, .medium)).foregroundStyle(Theme.text).lineLimit(1)
                        Spacer(minLength: 4)
                        if s.unread { Circle().fill(Theme.text).frame(width: 5, height: 5) }
                    }
                    Text(s.prNumber.map { "\(s.repo) · PR #\($0)" } ?? "\(s.repo) · \(s.branch)")
                        .font(Theme.mono(10)).foregroundStyle(Theme.textMuted).lineLimit(1)
                    HStack(spacing: 4) {
                        if s.origin == "card" { AnvilMark().sized(11) }
                        Text(s.origins).font(Theme.sans(11)).foregroundStyle(Theme.textMuted)
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(on ? Theme.surfaceHover : .clear))
            .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(on ? Theme.border : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8)
        .contextMenu {
            if let c = s.chats.first, sessions.selected != nil, sessions.selected != s.id {
                Button("Open beside this one") { sessions.splitChat = c.id }
            }
            Button("Archive") { sessions.archive(s) }
        }
    }
}
