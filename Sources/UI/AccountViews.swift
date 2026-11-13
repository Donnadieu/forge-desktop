import SwiftUI

extension AIAccount {
    /// The list's "Add an account" row.
    static let addingID = "+new"
}

/// A provider's accounts as radio rows (name, how it signs in, Clear), then "Add an account", whose form opens
/// under it when picked. Built like `OptionList`, with a Clear button on each account.
struct AccountList<Form: View>: View {
    let accounts: [AIAccount]
    @Binding var selection: String
    /// The account the project Forge runs now uses.
    let inUse: String?
    let clear: (AIAccount) -> Void
    @ViewBuilder var form: () -> Form

    var body: some View {
        VStack(spacing: 8) {
            ForEach(accounts) { a in
                row(a.id) {
                    HStack(spacing: 8) {
                        Text(a.name).font(Theme.sans(.body, .semibold)).foregroundStyle(Theme.text)
                        if a.id == inUse { Pill(text: "In use", tone: .green, dot: Theme.good) }
                    }
                    Text(a.line).font(Theme.sans(.body)).foregroundStyle(Theme.textSec)
                } trailing: {
                    Button("Clear") { clear(a) }.buttonStyle(ForgeButton(kind: .ghost, icon: "xmark"))
                }
            }
            row(AIAccount.addingID) {
                Text(accounts.isEmpty ? "Add your first account" : "Add an account").font(Theme.sans(.body, .semibold)).foregroundStyle(Theme.text)
                Text("Sign in with the browser or paste an API key. Keep as many as you like.").font(Theme.sans(.body))
                    .foregroundStyle(Theme.textSec)
                if selection == AIAccount.addingID { form().padding(.top, 6) }
            } trailing: {
                EmptyView()
            }
        }
    }

    private func row<L: View, T: View>(_ id: String, @ViewBuilder _ label: () -> L, @ViewBuilder trailing: () -> T) -> some View {
        let on = id == selection
        return HStack(alignment: .top, spacing: 12) {
            Radio(on: on).padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) { label() }
            Spacer(minLength: 0)
            trailing()
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: Theme.rLg).fill(on ? Theme.surfaceHover : Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: Theme.rLg).stroke(on ? Theme.borderHover : Theme.border))
        .contentShape(Rectangle())
        .onTapGesture { selection = id }
    }
}

/// The small sheet before an account is cleared: what goes, and which projects lose it. Cancel / Clear.
struct ClearAccountSheet: View {
    let account: AIAccount
    /// Projects that use this account.
    let projects: [String]
    let cancel: () -> Void
    let clear: () -> Void

    private var what: String {
        account.method == .key ? "its \(account.provider.keyName)" : "its \(account.provider.name) sign-in"
    }

    var body: some View {
        ZStack {
            Theme.bg.opacity(0.72).ignoresSafeArea().onTapGesture(perform: cancel)
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 16) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Clear \(account.name)?").font(Theme.display(.sheetTitle)).foregroundStyle(Theme.text)
                        Text("Forge forgets this account and removes \(what) from your Keychain. Your other accounts stay signed in.")
                            .font(Theme.sans(.body)).foregroundStyle(Theme.textSec).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                    Button(action: cancel) {
                        Image(systemName: "xmark").font(Theme.icon(.glyph, .semibold)).foregroundStyle(Theme.textSec)
                            .frame(width: 28, height: 28)
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(.cancelAction)
                }
                .padding(.horizontal, 24).padding(.vertical, 20)
                .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
                if !projects.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionLabel(text: "Projects that need another account")
                        ForEach(projects, id: \.self) { Text($0).font(Theme.mono(.small)).foregroundStyle(Theme.text) }
                    }
                    .padding(24)
                }
                HStack(spacing: 8) {
                    Spacer()
                    Button("Cancel", action: cancel).buttonStyle(ForgeButton(kind: .ghost))
                    Button("Clear", action: clear).buttonStyle(ForgeButton(kind: .primary)).keyboardShortcut(.defaultAction)
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
