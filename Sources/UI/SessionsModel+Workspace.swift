import Foundation

/// Sessions per workspace: a workspace shows, opens and acts on only its own sessions, and remembers what it had open.
/// Sessions of other workspaces keep running in the background (docs/decisions.md, 2026-11-11 session isolation).
extension SessionsModel {
    /// The session open on screen; never one from another workspace.
    var current: Sessions.Session? { sessions.first { $0.id == selected }.flatMap { belongs($0) ? $0 : nil } }

    /// The side-by-side chat, when it's one of this workspace's sessions.
    var split: Sessions.Chat? { chat(splitChat).flatMap { c in session(of: c).map(belongs) == true ? c : nil } }

    /// A session belongs to the workspace on screen ("default" = made before workspaces, shown in every one).
    func belongs(_ s: Sessions.Session) -> Bool { Self.belongs(s, to: workspace) }

    static func belongs(_ s: Sessions.Session, to workspace: String?) -> Bool {
        workspace == nil || s.workspaceId == workspace || s.workspaceId == "default"
    }

    /// A chat whose session belongs to the workspace on screen: the only ones steer, Stop and Create PR act on.
    func isHere(_ chat: Sessions.Chat) -> Bool { session(of: chat).map(belongs) ?? false }

    func sessions(in workspace: String?) -> [Sessions.Session] {
        sessions.filter { !$0.archived && Self.belongs($0, to: workspace) }
    }

    /// Switches the screen to a workspace: the one left keeps what it had open, the one shown gets its own back (or
    /// the New session pane when it had nothing open). Sheets about the workspace left close.
    func show(workspace w: String?) {
        guard w != workspace else { return }
        if let old = workspace { picks[old] = (selected, splitChat) }
        workspace = w
        let pick = w.flatMap { picks[$0] }
        selected = pick?.selected.flatMap { id in sessions.first { $0.id == id && !$0.archived && belongs($0) }?.id }
        splitChat = pick?.split
        if split == nil { splitChat = nil }
        composing = false
        (reviewSheet, openDiff, openFile, importSheet, showHistory) = (nil, nil, nil, nil, false)
        if let s = current { refreshSide(s.id) }
    }
}
