import SwiftUI

/// The top of the Changes panel: the title with the counts, and the pull request row (the number as a link, one
/// status, one button) or Create PR. Both fit every width the panel can be dragged to (300 to 560 pt): each row has
/// tiers, widest first, and the last tier shrinks (its label truncates, its button is an icon), so nothing clips.
struct PRRow: View {
    @ObservedObject var sessions: SessionsModel
    let session: Sessions.Session
    let pr: Sessions.PullRequest
    let chat: Sessions.Chat?
    @Binding var confirmMerge: Bool
    @Binding var showChecks: Bool

    private var action: PRAction? { pr.status?.action.flatMap(PRAction.init(rawValue:)) }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            row(.full)
            row(.short)
            row(.icon)
        }
    }

    enum Fit { case full, short, icon }

    private func row(_ fit: Fit) -> some View {
        HStack(spacing: 8) {
            PRNumber(pr: pr)
            if let st = pr.status {
                if st.tone == "checking" { Spinner() } else { Circle().fill(Self.tone(st.tone)).frame(width: 7, height: 7) }
                label(st.label, fit)
            } else {
                label(pr.state.capitalized, fit)
            }
            Spacer(minLength: 8)
            if let action { button(action, fit) }
        }
    }

    /// Whole in the first two tiers (so a tier that doesn't fit is skipped); truncated in the last.
    @ViewBuilder private func label(_ text: String, _ fit: Fit) -> some View {
        let t = Text(text).font(Theme.sans(.small, .medium)).foregroundStyle(Theme.text).lineLimit(1)
        if fit == .icon { t.truncationMode(.tail).layoutPriority(-1).help(text) } else { t.fixedSize() }
    }

    @ViewBuilder private func button(_ a: PRAction, _ fit: Fit) -> some View {
        let disabled = a.needsChat && chat == nil
        switch fit {
        case .full:
            Button(a.title) { run(a) }
                .buttonStyle(ForgeButton(kind: .primary, hint: a == .merge ? "⌘⇧M" : nil)).disabled(disabled).shortcut(a)
        case .short:
            Button(a.shortTitle) { run(a) }.buttonStyle(ForgeButton(kind: .primary)).disabled(disabled).help(a.title).shortcut(a)
        case .icon:
            Button {
                run(a)
            } label: {
                Image(systemName: a.icon)
            }
            .buttonStyle(ForgeButton(kind: .primary)).disabled(disabled).help(a.title).shortcut(a)
        }
    }

    private func run(_ a: PRAction) {
        switch a {
        case .merge: confirmMerge = true
        case .resolve:
            if let chat { sessions.send(chat, text: Sessions.Prompt.resolveConflicts(base: pr.base ?? session.base), queue: chat.working) }
        case .update: sessions.update(session)
        case .viewChecks: showChecks.toggle()
        case .pullComments: sessions.pullReviewComments(session)
        case .readyForReview: sessions.ready(session)
        case .open: if let u = URL(string: pr.url) { NSWorkspace.shared.open(u) }
        }
    }

    static func tone(_ t: String) -> Color {
        switch t {
        case "ready", "merged": return Theme.good
        case "failing": return Theme.bad
        case "blocked": return Theme.heat
        default: return Theme.textMuted
        }
    }
}

extension View {
    /// ⌘⇧M merges, the one keyboard shortcut the row's buttons have.
    @ViewBuilder fileprivate func shortcut(_ a: PRAction) -> some View {
        if a == .merge { keyboardShortcut("m", modifiers: [.command, .shift]) } else { self }
    }
}

/// "#1288 ↗": the pull request's number, a link to it on GitHub.
struct PRNumber: View {
    let pr: Sessions.PullRequest

    var body: some View {
        Button {
            if let u = URL(string: pr.url) { NSWorkspace.shared.open(u) }
        } label: {
            HStack(spacing: 4) {
                Text(verbatim: "#\(pr.number)").font(Theme.mono(.caption, .medium)).foregroundStyle(Theme.text)
                Image(systemName: "arrow.up.right").font(Theme.icon(.glyphTiny, .semibold)).foregroundStyle(Theme.textMuted)
            }
            .padding(.horizontal, 7).frame(height: 22)
            .overlay(RoundedRectangle(cornerRadius: Theme.rSm).stroke(Theme.border))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).fixedSize()
        .help("Open PR #\(pr.number) on GitHub")
    }
}

/// The panel's title: "Changes · 65 files +3,174 −1,365", shortened to "65 files +3,174 −1,365", then "65 files".
struct ChangesTitle<Trailing: View>: View {
    let files: [Sessions.FileChange]
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 8) {
            if files.isEmpty {
                Text("No changes yet").font(Theme.sans(.emphasis, .semibold)).foregroundStyle(Theme.text).lineLimit(1)
            } else {
                ViewThatFits(in: .horizontal) {
                    line(prefix: true, counts: true)
                    line(prefix: false, counts: true)
                    line(prefix: false, counts: false)
                }
            }
            Spacer(minLength: 8)
            trailing
        }
    }

    private func line(prefix: Bool, counts: Bool) -> some View {
        let n = files.count == 1 ? "1 file" : "\(files.count) files"
        return HStack(spacing: 8) {
            Text(prefix ? "Changes · \(n)" : n).font(Theme.sans(.emphasis, .semibold)).foregroundStyle(Theme.text)
            if counts {
                Text("+\(files.reduce(0) { $0 + $1.added })").font(Theme.mono(.caption)).foregroundStyle(Theme.good)
                Text("−\(files.reduce(0) { $0 + $1.removed })").font(Theme.mono(.caption)).foregroundStyle(Theme.heat)
            }
        }
        .lineLimit(1).fixedSize()
    }
}

/// No pull request yet: Create PR sends the agent the create-PR prompt; the arrow has a draft one, or pushes the
/// branch and opens GitHub's own page for it. Both halves are one control: same height, same corners outside, one
/// seam, and both dim together when there's nothing to put in a pull request.
struct CreatePRButton: View {
    @ObservedObject var sessions: SessionsModel
    let session: Sessions.Session
    let chat: Sessions.Chat
    let enabled: Bool

    var body: some View {
        ViewThatFits(in: .horizontal) {
            split(hint: true)
            split(hint: false)
        }
    }

    private func split(hint: Bool) -> some View {
        HStack(spacing: 1) {
            Button("Create PR") {
                sessions.send(chat, text: Sessions.Prompt.createPR(base: session.base, branch: session.branch), queue: chat.working)
            }
            .buttonStyle(SplitHalf(side: .main, hint: hint ? "⌘⇧P" : nil))
            .keyboardShortcut("p", modifiers: [.command, .shift])
            Menu {
                Button("Create draft PR") {
                    sessions.send(chat, text: Sessions.Prompt.createPR(base: session.base, branch: session.branch, draft: true), queue: chat.working)
                }
                Button("Create PR manually ↗") { sessions.publish(session) }
            } label: {
                Color.clear.frame(width: SplitHalf.arrowWidth, height: SplitHalf.height).contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .frame(width: SplitHalf.arrowWidth, height: SplitHalf.height)
            // A borderless menu tints its own label amber, on amber: the half and its arrow are drawn under it.
            .background {
                SplitHalf.shape(.arrow).fill(Theme.heat).overlay(
                    Image(systemName: "chevron.down").font(Theme.icon(.glyphXS, .bold)).foregroundStyle(Theme.bg))
            }
            .overlay { SplitHalf.shape(.arrow).stroke(Theme.heatBorder) }
            .help("Create draft PR, or Create PR manually")
        }
        .fixedSize()
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
        .help(enabled ? "" : "Nothing to put in a pull request yet")
    }
}

/// One half of a split button: the design system's small primary button (28 high), with the corners rounded only
/// on its outer side.
struct SplitHalf: ButtonStyle {
    enum Side { case main, arrow }
    static let height: CGFloat = 28
    static let arrowWidth: CGFloat = 26

    let side: Side
    var hint: String?
    @State private var hover = false

    static func shape(_ side: Side) -> UnevenRoundedRectangle {
        let r = Theme.rSm
        return side == .main
            ? UnevenRoundedRectangle(topLeadingRadius: r, bottomLeadingRadius: r, bottomTrailingRadius: 0, topTrailingRadius: 0)
            : UnevenRoundedRectangle(topLeadingRadius: 0, bottomLeadingRadius: 0, bottomTrailingRadius: r, topTrailingRadius: r)
    }

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 8) {
            configuration.label.font(Theme.sans(.caption, .semibold))
            if let hint { KeyHint(text: hint, onAmber: true) }
        }
        .lineLimit(1).fixedSize()
        .foregroundStyle(Theme.bg)
        .padding(.horizontal, 12)
        .frame(height: Self.height)
        .background(Self.shape(side).fill(configuration.isPressed ? Theme.heatDeep : (hover ? Theme.heatBright : Theme.heat)))
        .overlay(Self.shape(side).stroke(Theme.heatBorder))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
    }
}

/// The one button the pull request row shows, from the host's status (`mergeStatus` in engine sessions/github.ts),
/// with a shorter title and an icon for a narrow panel.
enum PRAction: String {
    case merge, resolve, update
    case viewChecks = "view_checks"
    case pullComments = "pull_comments"
    case readyForReview = "ready_for_review"
    case open

    var title: String {
        switch self {
        case .merge: return "Merge"
        case .resolve: return "Resolve"
        case .update: return "Update"
        case .viewChecks: return "View"
        case .pullComments: return "Pull into chat"
        case .readyForReview: return "Ready for review"
        case .open: return "View on GitHub"
        }
    }

    var shortTitle: String {
        switch self {
        case .pullComments: return "Pull"
        case .readyForReview: return "Ready"
        case .open: return "GitHub"
        default: return title
        }
    }

    var icon: String {
        switch self {
        case .merge: return "arrow.triangle.merge"
        case .resolve: return "arrow.triangle.2.circlepath"
        case .update: return "arrow.down.circle"
        case .viewChecks: return "list.bullet"
        case .pullComments: return "text.bubble"
        case .readyForReview: return "checkmark.circle"
        case .open: return "arrow.up.right"
        }
    }

    /// Sends the agent a message, so it needs the session's chat.
    var needsChat: Bool { self == .resolve }
}
