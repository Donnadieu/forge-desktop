import AppKit
import SwiftUI

/// The Sessions screen's two sidebars: how wide each may be, which ones fit the window, and the divider that resizes
/// them (docs/design/sidebar-pr-panel.md section 2). The chat in the middle always keeps `chatMin`.
enum SessionsLayout {
    enum Side { case left, right }

    struct Range {
        let min: CGFloat
        let max: CGFloat
        let normal: CGFloat
    }

    static let sessions = Range(min: 200, max: 400, normal: 260)
    static let changes = Range(min: 300, max: 560, normal: 360)
    static let chatMin: CGFloat = 480

    static func range(_ side: Side) -> Range { side == .left ? sessions : changes }

    /// The widths to draw (nil = closed). When the chat would get under `chatMin`, the Changes panel closes first,
    /// then the sessions list; the person's own choice stays as it was for when the window grows again.
    static func fit(total: CGFloat, left: CGFloat, right: CGFloat, leftOpen: Bool, rightOpen: Bool) -> (left: CGFloat?, right: CGFloat?) {
        var l: CGFloat? = leftOpen ? left : nil
        var r: CGFloat? = rightOpen ? right : nil
        if r != nil, total - (l ?? 0) - (r ?? 0) < chatMin { r = nil }
        if l != nil, total - (l ?? 0) < chatMin { l = nil }
        return (l, r)
    }

    /// A drag's width: under the narrowest by a margin closes the sidebar (nil); otherwise kept between its limits.
    static func drag(_ width: CGFloat, side: Side) -> CGFloat? {
        let r = range(side)
        if width < r.min - 40 { return nil }
        return Swift.min(r.max, Swift.max(r.min, width))
    }
}

/// The 1 pt line between a sidebar and the chat: hover shows the resize cursor and a small grip, a drag resizes,
/// a drag far enough in closes the sidebar, a double click puts the usual width back.
struct PaneDivider: View {
    let side: SessionsLayout.Side
    @Binding var width: Double
    @Binding var open: Bool
    @State private var hover = false
    @State private var start: Double?

    var body: some View {
        Rectangle().fill(Theme.border).frame(width: 1)
            .overlay {
                Capsule().fill(hover ? Theme.textMuted : .clear).frame(width: 4, height: 32)
            }
            .overlay {
                Color.clear.frame(width: 7).contentShape(Rectangle())
                    .onHover { inside in
                        hover = inside
                        if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
                    }
                    .gesture(
                        DragGesture(minimumDistance: 1, coordinateSpace: .global)
                            .onChanged { g in
                                let from = start ?? width
                                start = from
                                let dx = side == .left ? g.translation.width : -g.translation.width
                                if let w = SessionsLayout.drag(from + dx, side: side) {
                                    width = w
                                    open = true
                                } else {
                                    open = false
                                }
                            }
                            .onEnded { _ in
                                if !open { width = SessionsLayout.range(side).normal }
                                start = nil
                            }
                    )
                    .onTapGesture(count: 2) { width = SessionsLayout.range(side).normal }
            }
    }
}

/// The toggle for a sidebar, the same for both sides: "Hide sessions" / "Sessions", "Hide changes" / "Changes".
struct SidebarToggle: View {
    let side: SessionsLayout.Side
    @Binding var open: Bool

    private var name: String { side == .left ? "sessions" : "changes" }

    var body: some View {
        Button(open ? "Hide \(name)" : name.capitalized) { open.toggle() }
            .buttonStyle(ForgeButton(kind: .ghost, icon: side == .left ? "sidebar.left" : "sidebar.right"))
            .lineLimit(1).fixedSize()
            .help(side == .left ? "Show or hide the sessions (⌘⇧S)" : "Show or hide the changes (⌘⇧D)")
    }
}
