import AppKit
import SwiftUI

/// The branch in a session's header: a click copies it (the name says "Copied" for a moment), the chevron has Copy
/// branch name and Rename branch… Renaming is only offered before a pull request is open: GitHub closes a pull
/// request when its branch is renamed (tested on a throwaway PR, Nov 11), so the menu says so instead.
struct BranchMenu: View {
    @ObservedObject var sessions: SessionsModel
    let session: Sessions.Session
    @State private var copied = BranchMenu.copiedInRender

    /// Renders draw the "Copied" moment.
    @MainActor static var copiedInRender = false

    /// Why this session's branch can't be renamed here; nil when it can.
    static func renameBlock(_ s: Sessions.Session) -> String? {
        if s.origin == "card" { return "The agent working this card owns its branch" }
        if s.prNumber != nil, s.prState == "OPEN" { return "GitHub closes the PR when its branch is renamed" }
        return nil
    }

    var body: some View {
        HStack(spacing: 2) {
            Button(action: copy) {
                Text(copied ? "Copied" : session.branch)
                    .foregroundStyle(copied ? Theme.good : Theme.textSec)
                    .lineLimit(1).truncationMode(.middle)
            }
            .buttonStyle(.plain)
            .help("Copy \(session.branch)")
            Menu {
                Button("Copy branch name", action: copy)
                if let why = Self.renameBlock(session) {
                    Button("Rename branch…") {}.disabled(true)
                    Text(why)
                } else {
                    Button("Rename branch…") { sessions.renameAsk = session }
                }
            } label: {
                Image(systemName: "chevron.down").font(Theme.icon(.glyphTiny, .semibold))
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        }
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(session.branch, forType: .string)
        copied = true
        Task {
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            copied = false
        }
    }
}

/// Rename branch: one field with the current name. The branch is renamed here and, if it was pushed, on GitHub.
struct RenameBranchSheet: View {
    @ObservedObject var sessions: SessionsModel
    let session: Sessions.Session
    @State private var name: String

    init(sessions: SessionsModel, session: Sessions.Session) {
        self.sessions = sessions
        self.session = session
        _name = State(initialValue: session.branch)
    }

    private var clean: String { name.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        SessionSheet(
            title: "Rename branch",
            lead: "Renames it in this session's folder and on GitHub, if it was pushed.",
            close: dismiss, width: 480
        ) {
            TextField("", text: $name).forgeField(hint: "Branch name", empty: name.isEmpty, icon: "arrow.triangle.branch")
                .onSubmit(save)
        } buttons: {
            Button("Rename", action: save)
                .buttonStyle(ForgeButton(kind: .primary, large: true))
                .disabled(clean.isEmpty || clean == session.branch || clean.contains(" "))
        }
    }

    private func dismiss() { sessions.renameAsk = nil }

    private func save() {
        guard !clean.isEmpty, clean != session.branch else { return }
        sessions.rename(session, to: clean)
    }
}

/// The one question archiving asks when something still runs: a card Forge is working, or a chat mid-turn.
struct ArchiveSheet: View {
    @ObservedObject var sessions: SessionsModel
    let ask: SessionsModel.ArchiveAsk

    var body: some View {
        SessionSheet(title: ask.title, lead: ask.message, close: dismiss, width: 480) {
            EmptyView()
        } buttons: {
            Button("Archive") {
                sessions.archive(ask.session)
                sessions.archiveAsk = nil
            }
            .buttonStyle(ForgeButton(kind: .primary, large: true))
            .keyboardShortcut(.defaultAction)
        }
    }

    private func dismiss() { sessions.archiveAsk = nil }
}
