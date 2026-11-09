import SwiftUI

/// The left list: search, New session, then the sessions grouped by what they need from you, and Import from
/// Conductor at the bottom. Right-click a row to open it beside the one on screen or to archive it.
struct SessionList: View {
    @ObservedObject var model: AppModel
    @ObservedObject var sessions: SessionsModel
    let list: [Sessions.Session]
    @State private var search = ""

    static let groups: [(status: [String], title: String)] = [
        (["needs_you"], "Needs you"), (["working"], "Working"), (["review"], "Ready for review"), (["idle"], "Idle"), (["merged"], "Merged"),
    ]

    private var shown: [Sessions.Session] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return list }
        return list.filter { ($0.title + " " + $0.repo + " " + $0.branch + " " + ($0.prTitle ?? "")).lowercased().contains(q) }
    }

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
                    ForEach(Self.groups, id: \.title) { g in
                        let rows = shown.filter { g.status.contains($0.status) }
                        if !rows.isEmpty {
                            SectionLabel(text: g.title).padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 6)
                            ForEach(rows) { s in row(s) }
                        }
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
