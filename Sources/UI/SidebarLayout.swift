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
        func clamp(_ w: Double) -> CGFloat { Swift.min(max, Swift.max(min, CGFloat(w))) }
    }

    static let sessions = Range(min: 200, max: 400, normal: 260)
    static let changes = Range(min: 300, max: 560, normal: 360)
    static let chatMin: CGFloat = 480
    /// Every pane's header (sessions list, chat, Changes panel, New session) is this tall, its line included; it grows
    /// with the zoom, like the text in it.
    static var headerHeight: CGFloat { Zoom.shared.scaled(112) }

    /// Where the window keeps its sidebars' widths and whether they're open (Forge has one main window, "main").
    struct Store {
        static let leftWidth = "sessions.main.left.width"
        static let rightWidth = "sessions.main.right.width"
        static let leftOpen = "sessions.main.left.open"
        static let rightOpen = "sessions.main.right.open"
        let defaults: UserDefaults

        /// Everything is read before anything is set: each change saves the whole layout.
        @MainActor func load(into m: SessionsModel) {
            let l = defaults.object(forKey: Self.leftWidth) as? Double
            let r = defaults.object(forKey: Self.rightWidth) as? Double
            let lo = defaults.object(forKey: Self.leftOpen) as? Bool
            let ro = defaults.object(forKey: Self.rightOpen) as? Bool
            if let l { m.leftWidth = sessions.clamp(l) }
            if let r { m.rightWidth = changes.clamp(r) }
            if let lo { m.showSessions = lo }
            if let ro { m.showChanges = ro }
        }

        @MainActor func save(_ m: SessionsModel) {
            defaults.set(Double(m.leftWidth), forKey: Self.leftWidth)
            defaults.set(Double(m.rightWidth), forKey: Self.rightWidth)
            defaults.set(m.showSessions, forKey: Self.leftOpen)
            defaults.set(m.showChanges, forKey: Self.rightOpen)
        }
    }

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

/// The 1 pt line between a sidebar and the chat, with a grab strip 9 pt wide over it. The strip is an AppKit view
/// (`DividerHandle`): the panes on either side hold AppKit views too (the transcript, the lists, the text fields),
/// and a SwiftUI drag gesture on a strip that overlaps them never got the mouse (Omar, Nov 12: the Changes panel's
/// edge did nothing). An AppKit view takes the press itself, shows the resize cursor from its cursor rect, and keeps
/// the drag even when the pointer runs ahead of the line. A drag resizes between the side's limits, a drag far
/// enough in closes the sidebar, a double click puts the usual width back.
struct PaneDivider: View {
    let side: SessionsLayout.Side
    @Binding var width: CGFloat
    @Binding var open: Bool
    @State private var hover = false
    @State private var start: CGFloat?

    static let grab: CGFloat = 9

    var body: some View {
        Rectangle().fill(Theme.border).frame(width: 1)
            .overlay {
                ZStack {
                    Capsule().fill(hover || start != nil ? Theme.textMuted : .clear).frame(width: 3, height: 32).allowsHitTesting(false)
                    DividerHandle(
                        hover: { hover = $0 },
                        began: { start = width },
                        moved: { dx in
                            let from = start ?? width
                            if let w = SessionsLayout.drag(from + (side == .left ? dx : -dx), side: side) {
                                width = w
                                if !open { open = true }
                            } else if open {
                                open = false
                            }
                        },
                        ended: {
                            if !open { width = SessionsLayout.range(side).normal }
                            start = nil
                        },
                        reset: { width = SessionsLayout.range(side).normal })
                }
                .frame(width: Self.grab)
            }
            .zIndex(1)
    }
}

/// The AppKit strip that takes a divider's mouse: press, drag (in points from the press), release, double click,
/// hover, and the left-right resize cursor.
struct DividerHandle: NSViewRepresentable {
    var hover: (Bool) -> Void
    var began: () -> Void
    var moved: (CGFloat) -> Void
    var ended: () -> Void
    var reset: () -> Void

    final class Strip: NSView {
        var handle: DividerHandle?
        private var from: CGFloat?
        private var area: NSTrackingArea?

        override var mouseDownCanMoveWindow: Bool { false }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override func resetCursorRects() { addCursorRect(bounds, cursor: .resizeLeftRight) }

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let area { removeTrackingArea(area) }
            let a = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
            addTrackingArea(a)
            area = a
        }

        override func mouseEntered(with event: NSEvent) { handle?.hover(true) }
        override func mouseExited(with event: NSEvent) { if from == nil { handle?.hover(false) } }

        override func mouseDown(with event: NSEvent) {
            if event.clickCount == 2 { return handle?.reset() ?? () }
            from = event.locationInWindow.x
            handle?.began()
        }

        override func mouseDragged(with event: NSEvent) {
            guard let from else { return }
            handle?.moved(event.locationInWindow.x - from)
        }

        override func mouseUp(with event: NSEvent) {
            guard from != nil else { return }
            from = nil
            handle?.ended()
            handle?.hover(false)
        }
    }

    func makeNSView(context: Context) -> Strip {
        let v = Strip()
        v.handle = self
        return v
    }

    func updateNSView(_ v: Strip, context: Context) { v.handle = self }
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

/// The top of a pane on the Sessions screen (sessions list, chat, Changes panel, New session): one shared height,
/// so the line under every pane's header sits at the same y, the same 1 pt border line.
struct PaneHeader<Content: View>: View {
    var alignment: Alignment = .leading
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) {
            content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: alignment)
                .frame(height: SessionsLayout.headerHeight - 1)
            Rectangle().fill(Theme.border).frame(height: 1)
        }
    }
}
