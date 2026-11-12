import SwiftUI

/// The Environment tile: one row per variable (key, value, Secret), Add variable. A secret is typed into a masked
/// field once; after Save it lives in the Keychain and the row shows dots (typing again replaces it).
struct EnvEditor: View {
    @Binding var rows: [EnvRow]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel(text: "Environment")
            Text("Given to every agent, script and Terminal in this workspace. Secrets stay in your Mac's Keychain and are never written to a file.")
                .font(Theme.sans(12)).foregroundStyle(Theme.textSec).fixedSize(horizontal: false, vertical: true)
            if !rows.isEmpty {
                HStack(spacing: 10) {
                    SectionLabel(text: "Key").frame(width: 220, alignment: .leading)
                    SectionLabel(text: "Value").frame(maxWidth: .infinity, alignment: .leading)
                    SectionLabel(text: "Secret").frame(width: 56, alignment: .leading)
                    Color.clear.frame(width: 28, height: 1)
                }
            }
            ForEach($rows) { $row in
                HStack(spacing: 10) {
                    TextField("", text: $row.key).forgeField(mono: true, hint: "KEY", empty: row.key.isEmpty).frame(width: 220)
                        .overlay(alignment: .trailing) {
                            if !row.key.isEmpty, !WorkspaceEnv.validKey(row.key) {
                                Text("letters, digits, _").font(Theme.sans(10)).foregroundStyle(Theme.heatBright).padding(.trailing, 10)
                            }
                        }
                    Group {
                        if row.secret {
                            SecureField("", text: $row.value).forgeField(
                                mono: true, hint: row.kept ? WorkspaceEnv.mask : "value", empty: row.value.isEmpty, icon: "lock")
                        } else {
                            TextField("", text: $row.value).forgeField(mono: true, hint: "value", empty: row.value.isEmpty)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    ForgeToggle(on: $row.secret).frame(width: 56, alignment: .leading)
                        .help(row.secret ? "Kept in the Keychain, shown as dots" : "Make it a secret")
                    Button {
                        rows.removeAll { $0.id == row.id }
                    } label: {
                        Image(systemName: "xmark").font(.system(size: 10, weight: .semibold))
                    }
                    .buttonStyle(ForgeButton(kind: .ghost)).frame(width: 28).help("Remove this variable")
                }
            }
            Button("Add variable") { rows.append(EnvRow(key: "", value: "", secret: false)) }
                .buttonStyle(ForgeButton(kind: .secondary, icon: "plus"))
        }
        .padding(20).frame(maxWidth: .infinity, alignment: .leading).panel()
    }
}

/// "Add from repo": what git ignores in the workspace's checkouts, each with a tick; a tick adds it to the list.
struct RepoFilePicker: View {
    @ObservedObject var model: AppModel
    let picked: [String]
    let add: (String) -> Void
    @State private var open = false
    @State private var found: [(repo: String, paths: [String])]?

    var body: some View {
        Button("Add from repo") { open = true }
            .buttonStyle(ForgeButton(kind: .secondary, icon: "folder.badge.plus"))
            .popover(isPresented: $open, arrowEdge: .bottom) {
                RepoFileList(found: found, picked: picked, add: add).task {
                    if found == nil { found = model.preview ? RepoFileList.sample : await model.ignoredFiles() }
                }
            }
    }
}

struct RepoFileList: View {
    let found: [(repo: String, paths: [String])]?
    let picked: [String]
    let add: (String) -> Void

    static let sample: [(repo: String, paths: [String])] = [
        ("acme/app", [".env", "config/master.key", "log/", "node_modules/", "storage/", "tmp/"])
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: "What git ignores in your checkout").padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 8)
            if let found {
                if found.allSatisfy({ $0.paths.isEmpty }) {
                    Text(
                        found.isEmpty
                            ? "No repo of this workspace has a checkout on this Mac, so there's nothing to copy."
                            : "Git ignores nothing in your checkout."
                    )
                    .font(Theme.sans(12)).foregroundStyle(Theme.textSec).padding(14)
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(found, id: \.repo) { r in
                            if found.count > 1 { Text(r.repo).font(Theme.mono(10)).foregroundStyle(Theme.textMuted).padding(.top, 6) }
                            ForEach(r.paths.filter { !$0.hasPrefix(".env") }, id: \.self) { p in
                                let on = picked.contains(p)
                                CheckRow(on: .constant(on)) { Text(p).font(Theme.mono(12)).foregroundStyle(Theme.text) }
                                    .padding(.vertical, 4).contentShape(Rectangle())
                                    .onTapGesture { if !on { add(p) } }
                            }
                        }
                    }
                    .padding(.horizontal, 14).padding(.bottom, 12)
                }
                .frame(maxHeight: 320)
            } else {
                HStack(spacing: 8) {
                    Spinner()
                    Text("Reading your checkout…").font(Theme.sans(12)).foregroundStyle(Theme.textSec)
                }
                .padding(14)
            }
        }
        .frame(width: 360)
        .background(Theme.surface)
    }
}
