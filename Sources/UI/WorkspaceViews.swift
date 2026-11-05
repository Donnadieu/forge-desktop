import SwiftUI

/// The workspace sheets: switch to another workspace, run another project, name a new one, rename or delete
/// the one on screen. One at a time, over any screen (`AppModel.ask`).
enum WorkspaceAsk: Equatable {
    case switchTo(Workspace)
    case run(ProjectRecord)
    case new
    case rename
    case delete
    case clearConnection(TrackerRecord)
}

extension Workspace {
    /// The tile's colour.
    var tint: Color {
        switch color {
        case "green": return Theme.good
        case "cream": return Theme.silver
        case "grey": return Theme.textMuted
        case "red": return Theme.bad
        case "gold": return Theme.heatBright
        default: return Theme.heat
        }
    }
}

/// A workspace's small square tile: its two letters on its colour.
struct WorkspaceTile: View {
    let initials: String
    let tint: Color
    var size: CGFloat = 22

    init(_ w: Workspace, size: CGFloat = 22) {
        (initials, tint, self.size) = (w.initials, w.tint, size)
    }

    init(initials: String, tint: Color, size: CGFloat = 22) {
        (self.initials, self.tint, self.size) = (initials, tint, size)
    }

    var body: some View {
        Text(initials)
            .font(Theme.mono(size * 0.42, .medium))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(tint.opacity(0.16)))
            .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(tint.opacity(0.5)))
    }
}

/// The top bar's workspace chip: the one on screen; a click lists them all.
struct WorkspaceChip: View {
    @ObservedObject var model: AppModel
    @State private var open = false

    var body: some View {
        if let w = model.workspace {
            Button {
                open.toggle()
            } label: {
                HStack(spacing: 8) {
                    WorkspaceTile(w)
                    Text(w.name).font(Theme.sans(13, .medium)).foregroundStyle(Theme.text).lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.textSec)
                }
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(open ? Theme.surfaceHover : .clear))
                .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.border))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .fixedSize()
            .popover(isPresented: $open, arrowEdge: .bottom) {
                WorkspaceSwitcher(model: model) { open = false }
            }
        }
    }
}

/// Every workspace with what it holds and whether it runs, then New workspace and its settings.
struct WorkspaceSwitcher: View {
    @ObservedObject var model: AppModel
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: "Workspaces").padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 8)
            ForEach(model.store.workspaceList) { w in
                row(w)
            }
            Rectangle().fill(Theme.border).frame(height: 1).padding(.vertical, 6)
            plain("New workspace", icon: "plus") { model.ask = .new }
            plain("Workspace settings", icon: "gearshape") { model.go(AppModel.settingsScreen) }
                .padding(.bottom, 8)
            Text("One workspace runs at a time. Switching stops the one running.")
                .font(Theme.sans(11)).foregroundStyle(Theme.textMuted)
                .padding(.horizontal, 16).padding(.bottom, 14).fixedSize(horizontal: false, vertical: true)
        }
        .frame(width: 400)
        .background(Theme.surface)
    }

    private func row(_ w: Workspace) -> some View {
        let here = w.id == model.workspace?.id
        return Button {
            close()
            if !here { model.ask = .switchTo(w) }
        } label: {
            HStack(spacing: 12) {
                WorkspaceTile(w, size: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(w.name).font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
                    Text(model.summary(w)).font(Theme.sans(11)).foregroundStyle(Theme.textMuted).lineLimit(2)
                }
                Spacer(minLength: 8)
                if here && model.running {
                    HStack(spacing: 6) {
                        PulseDot(color: Theme.heat, pulsing: true, size: 6)
                        Text("Running").font(Theme.sans(11, .medium)).foregroundStyle(Theme.heatBright)
                    }
                } else {
                    Text("Stopped").font(Theme.sans(11)).foregroundStyle(Theme.textMuted)
                }
                Image(systemName: "checkmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.text).opacity(here ? 1 : 0)
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
            .background(here ? Theme.surfaceHover : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func plain(_ title: String, icon: String, _ action: @escaping () -> Void) -> some View {
        Button {
            close()
            action()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: icon).font(.system(size: 11, weight: .medium)).frame(width: 28)
                Text(title).font(Theme.sans(13))
                Spacer()
            }
            .foregroundStyle(Theme.textSec)
            .padding(.horizontal, 16).padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The sheet for `model.ask`.
struct WorkspaceSheet: View {
    @ObservedObject var model: AppModel
    let ask: WorkspaceAsk
    @State private var name = ""
    @State private var color = "heat"

    var body: some View {
        switch ask {
        case .switchTo(let w):
            ForgeSheet(
                title: "Switch to \(w.name)?",
                lead: model.running
                    ? "\(model.workspace?.name ?? "This workspace") stops. Running agents finish their turn first. \(w.name) opens stopped; press Start when you're ready."
                    : "\(w.name) opens stopped; press Start when you're ready. Your cards stay where they are.",
                action: "Switch", cancel: close
            ) {
                EmptyView()
            } act: {
                run { await model.open(workspace: w.id) }
            }
        case .run(let p):
            ForgeSheet(
                title: "Run \(p.name)?",
                lead: (model.running ? "The project running now stops. Running agents finish their turn first. " : "")
                    + (p.choices == nil && p.repo == nil
                        ? "Forge then asks for this project's repo and intelligence provider." : "It opens stopped; press Start when you're ready."),
                action: "Run it", cancel: close
            ) {
                EmptyView()
            } act: {
                run { await model.open(workspace: p.workspaceID ?? model.workspace?.id ?? "", project: p.id) }
            }
        case .new, .rename:
            ForgeSheet(
                title: ask == .new ? "New workspace" : "Rename \(model.workspace?.name ?? "")",
                lead: ask == .new
                    ? "A workspace groups the trackers, projects, repos and intelligence providers Forge runs together. "
                        + "Sign-ins already on this Mac can be used here without signing in again."
                    : "Its projects and sign-ins don't change.",
                action: ask == .new ? "Create and set up" : "Save", enabled: !trimmed.isEmpty, cancel: close
            ) {
                nameForm
            } act: {
                if ask == .new {
                    let (n, c) = (trimmed, color)
                    run { await model.newWorkspace(name: n, color: c) }
                } else {
                    model.renameWorkspace(trimmed, color: color)
                    close()
                }
            }
            .onAppear {
                if ask == .rename, let w = model.workspace { (name, color) = (w.name, w.color ?? "heat") }
            }
        case .clearConnection(let t):
            ForgeSheet(
                title: "Clear \(t.title)?",
                lead: "Forge forgets this \(t.kind.name) connection and removes its sign-in from your Keychain. "
                    + "Your other connections stay signed in.",
                action: "Clear", cancel: close
            ) {
                EmptyView()
            } act: {
                model.forget(connection: t)
                close()
            }
        case .delete:
            ForgeSheet(
                title: "Delete \(model.workspace?.name ?? "")?",
                lead: "Forge forgets this workspace and the projects it manages. Your cards, repos and sign-ins stay; "
                    + "another workspace can use them.",
                action: "Delete", cancel: close
            ) {
                EmptyView()
            } act: {
                run { await model.deleteWorkspace() }
            }
        }
    }

    private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var nameForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: "Name")
            TextField("", text: $name).forgeField(hint: "Side projects", empty: name.isEmpty)
            SectionLabel(text: "Colour").padding(.top, 6)
            HStack(spacing: 10) {
                ForEach(Workspace.colors, id: \.self) { c in
                    let tile = Workspace(id: "", name: trimmed.isEmpty ? "W" : trimmed, color: c)
                    WorkspaceTile(tile, size: 30)
                        .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.text, lineWidth: c == color ? 2 : 0))
                        .onTapGesture { color = c }
                }
            }
        }
    }

    private func close() { model.ask = nil }

    private func run(_ f: @escaping () async -> Void) {
        model.ask = nil
        Task { await f() }
    }
}

/// A small centred sheet: title, one plain paragraph, optional content, Cancel and one main button.
struct ForgeSheet<Content: View>: View {
    let title: String
    let lead: String
    let action: String
    var enabled = true
    let cancel: () -> Void
    @ViewBuilder var content: () -> Content
    let act: () -> Void

    var body: some View {
        ZStack {
            Theme.bg.opacity(0.72).ignoresSafeArea().onTapGesture(perform: cancel)
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(title).font(Theme.display(24)).foregroundStyle(Theme.text)
                    Text(lead).font(Theme.sans(13)).foregroundStyle(Theme.textSec).fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 24).padding(.vertical, 20)
                .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
                if Content.self != EmptyView.self {
                    content().padding(24)
                }
                HStack(spacing: 8) {
                    Spacer()
                    Button("Cancel", action: cancel).buttonStyle(ForgeButton(kind: .ghost)).keyboardShortcut(.cancelAction)
                    Button(action, action: act).buttonStyle(ForgeButton(kind: .primary)).keyboardShortcut(.defaultAction).disabled(!enabled)
                }
                .padding(.horizontal, 24).padding(.vertical, 20)
            }
            .frame(width: 520)
            .background(RoundedRectangle(cornerRadius: Theme.rXl).fill(Theme.surface))
            .clipShape(RoundedRectangle(cornerRadius: Theme.rXl))
            .overlay(RoundedRectangle(cornerRadius: Theme.rXl).stroke(Theme.border))
            .shadow(color: .black.opacity(0.4), radius: 16, y: 4)
        }
    }
}
