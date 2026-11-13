import SwiftUI

/// Workspace setup (Omar, Nov 12; docs/design/workspace-settings.md): one page for what every new session of the
/// workspace gets (files copied from the checkout, a setup script) and what runs when one is archived (a cleanup
/// script), plus the environment given to every agent, script and terminal. One Save. Opened from Settings.
struct WorkspaceSetupScreen: View {
    @ObservedObject var model: AppModel
    @State private var copy: [String] = []
    @State private var newPath = ""
    @State private var setupScript = ""
    @State private var cleanupScript = ""
    @State private var rows: [EnvRow] = []
    @State private var loaded: String?
    @State private var saved = false

    private var name: String { model.workspace?.name ?? "Workspace" }

    var body: some View {
        VStack(spacing: 0) {
            TopBar(suffix: "Settings") {
                Button("Back to Settings") { model.go(AppModel.settingsScreen) }
                    .buttonStyle(ForgeButton(kind: .ghost, hint: "esc", icon: "chevron.left"))
                    .keyboardShortcut(.cancelAction)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    PageHeader(
                        eyebrow: "\(name) · Workspace setup", title: "Workspace setup",
                        lead: "What every new session gets before its agent starts, and what runs when it's archived.")
                    filesTile
                    scriptTile(
                        "Setup script",
                        "Runs in the new session's folder when it starts. Its output shows in the session; if it fails, the agent still starts.",
                        text: $setupScript, hint: "bundle install && bin/rails db:prepare")
                    scriptTile(
                        "Cleanup script", "Runs in the session's folder when it's archived, before the folder goes.", text: $cleanupScript,
                        hint: "bin/rails db:drop")
                    EnvEditor(rows: $rows)
                    HStack(spacing: 10) {
                        Text(
                            saved
                                ? "Saved. New sessions and Terminal tabs use it now."
                                : "New sessions and Terminal tabs use these at once; card agents get the variables when the engine restarts."
                        )
                        .font(Theme.sans(.caption)).foregroundStyle(saved ? Theme.heatBright : Theme.textMuted)
                        Spacer()
                        Button("Cancel") { model.go(AppModel.settingsScreen) }.buttonStyle(ForgeButton(kind: .secondary, large: true))
                        Button("Save") { save() }.buttonStyle(ForgeButton(kind: .primary, hint: "⌘S", large: true))
                            .keyboardShortcut("s", modifiers: .command)
                    }
                }
                .padding(.horizontal, 40).padding(.top, 32).padding(.bottom, 40)
                .frame(maxWidth: 980, alignment: .leading)
            }
        }
        .background(Atmosphere())
        .onAppear(perform: load)
    }

    private func load() {
        guard loaded != model.workspace?.id else { return }
        loaded = model.workspace?.id
        let s = model.workspace?.setup ?? WorkspaceSetup()
        copy = s.copy ?? []
        setupScript = s.setupScript ?? ""
        cleanupScript = s.cleanupScript ?? ""
        rows = EnvRow.rows(s.env ?? [])
    }

    private func save() {
        if !newPath.isBlank { add(newPath) }
        model.saveWorkspaceSetup(copy: copy, setupScript: setupScript, cleanupScript: cleanupScript, rows: rows)
        rows = EnvRow.rows(model.workspace?.setup?.env ?? [])
        saved = true
    }

    private func add(_ path: String) {
        let p = path.trimmingCharacters(in: .whitespaces)
        if !p.isEmpty, !copy.contains(p) { copy.append(p) }
        newPath = ""
        saved = false
    }

    private func tile<C: View>(_ title: String, _ lead: String, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel(text: title)
            Text(lead).font(Theme.sans(.small)).foregroundStyle(Theme.textSec).fixedSize(horizontal: false, vertical: true)
            content()
        }
        .padding(20).frame(maxWidth: .infinity, alignment: .leading).panel()
    }

    private var filesTile: some View {
        tile("Files to copy", "Files git ignores, copied from your checkout into each new session's folder. .env files always come along.") {
            VStack(spacing: 0) {
                ForEach(copy, id: \.self) { p in
                    HStack {
                        Image(systemName: p.hasSuffix("/") ? "folder" : "doc").font(Theme.icon(.glyph)).foregroundStyle(Theme.textMuted)
                        Text(p).font(Theme.mono(.small)).foregroundStyle(Theme.text)
                        Spacer()
                        Button {
                            copy.removeAll { $0 == p }
                            saved = false
                        } label: {
                            Image(systemName: "xmark").font(Theme.icon(.glyphS, .semibold))
                        }
                        .buttonStyle(ForgeButton(kind: .ghost)).help("Stop copying \(p)")
                    }
                    .padding(.vertical, 6)
                    .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1).opacity(0.8) }
                }
            }
            HStack(spacing: 8) {
                TextField("", text: $newPath).forgeField(mono: true, hint: "config/master.key", empty: newPath.isEmpty).onSubmit { add(newPath) }
                Button("Add") { add(newPath) }.buttonStyle(ForgeButton(kind: .secondary)).disabled(newPath.isBlank)
                RepoFilePicker(model: model, picked: copy) { p in add(p) }
            }
        }
    }

    private func scriptTile(_ title: String, _ lead: String, text: Binding<String>, hint: String) -> some View {
        tile(title, lead) {
            ZStack(alignment: .topLeading) {
                if text.wrappedValue.isEmpty {
                    Text(hint).font(Theme.mono(.small)).foregroundStyle(Theme.textMuted).padding(.leading, 5).padding(.top, 1)
                }
                TextEditor(text: text).font(Theme.mono(.small)).foregroundStyle(Theme.text).scrollContentBackground(.hidden)
                    .frame(minHeight: 58, maxHeight: 140).fixedSize(horizontal: false, vertical: true)
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: Theme.rLg).fill(Theme.bg))
            .overlay(RoundedRectangle(cornerRadius: Theme.rLg).stroke(Theme.border))
        }
    }
}
