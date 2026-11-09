import SwiftUI

/// History: the workspace's archived sessions, newest first, each with Restore (its folder is made again on its
/// branch and its chats come back where they were).
struct HistorySheet: View {
    @ObservedObject var model: AppModel
    @ObservedObject var sessions: SessionsModel

    private var list: [Sessions.Session] {
        sessions.archived(in: model.workspace?.id).sorted { $0.updatedAt > $1.updatedAt }
    }

    var body: some View {
        SessionSheet(
            title: "History",
            lead: list.isEmpty ? "No archived sessions in this workspace yet." : "Archived sessions keep their chats and changes.",
            close: dismiss
        ) {
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(list) { s in
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(s.title).font(Theme.sans(13, .medium)).foregroundStyle(Theme.text).lineLimit(1)
                                Text("\(s.repo) · \(s.branch)").font(Theme.mono(11)).foregroundStyle(Theme.textMuted).lineLimit(1)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            Button("Restore") { sessions.restore(s) }.buttonStyle(ForgeButton(kind: .secondary, icon: "arrow.uturn.backward"))
                        }
                        .padding(.vertical, 10)
                        .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
                    }
                }
            }
            .frame(maxHeight: 360)
        } buttons: {
            Button("Close", action: dismiss).buttonStyle(ForgeButton(kind: .ghost)).keyboardShortcut(.escape, modifiers: [])
        }
    }

    private func dismiss() { sessions.showHistory = false }
}
