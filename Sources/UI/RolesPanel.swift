import SwiftUI

/// Roles on the intelligence provider step: Plans, Builds, Reviews and Tests can each have their own provider
/// account and model; stages no role takes use the provider picked above ("Every other stage"). Accounts are the
/// ones already on this Mac (add one above first). Design frame w7.
struct RolesPanel: View {
    @ObservedObject var model: AppModel
    @Binding var roles: [RoleChoice]

    private var accounts: [AIAccount] { model.store.accounts }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: "Roles")
            VStack(spacing: 0) {
                header
                ForEach(StageRole.allCases, id: \.self) { r in
                    Rectangle().fill(Theme.border).frame(height: 1)
                    row(r)
                }
            }
            .panel()
            .clipShape(RoundedRectangle(cornerRadius: Theme.rLg))
            Text(
                "A role works its stages with its own account and model; a card moving to its stage is picked up by it. Continue saves and restarts the engine."
            )
            .font(Theme.sans(11)).foregroundStyle(Theme.textMuted).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: 760)
    }

    private var header: some View {
        HStack(spacing: 12) {
            SectionLabel(text: "Role").frame(width: 80, alignment: .leading)
            SectionLabel(text: "Stages").frame(width: 150, alignment: .leading)
            SectionLabel(text: "Account").frame(maxWidth: .infinity, alignment: .leading)
            SectionLabel(text: "Model").frame(width: 200, alignment: .leading)
        }
        .padding(.horizontal, 16).frame(height: 36)
    }

    private func row(_ r: StageRole) -> some View {
        let choice = roles.first { $0.role == r }
        let account = choice.flatMap { model.store.account($0.accountID) }
        return HStack(spacing: 12) {
            Text(r.name).font(Theme.sans(13, .medium)).foregroundStyle(Theme.text).frame(width: 80, alignment: .leading)
            Text(r.stages.joined(separator: ", ")).font(Theme.sans(12)).foregroundStyle(Theme.textSec).frame(width: 150, alignment: .leading)
            Picker("", selection: Binding(get: { account?.id ?? "" }, set: { set(r, account: $0) })) {
                Text("Same as every other stage").tag("")
                ForEach(accounts) { a in Text("\(a.provider.name) · \(a.name)").tag(a.id) }
            }
            .labelsHidden()
            .frame(maxWidth: .infinity, alignment: .leading)
            Group {
                if let account {
                    Picker("", selection: Binding(get: { choice?.model ?? account.provider.models[0] }, set: { set(r, model: $0) })) {
                        ForEach(account.provider.models, id: \.self) { Text($0.isEmpty ? "Its usual model" : $0).tag($0) }
                    }
                    .labelsHidden()
                } else {
                    Text("Uses the one above").font(Theme.sans(12)).foregroundStyle(Theme.textMuted)
                }
            }
            .frame(width: 200, alignment: .leading)
        }
        .padding(.horizontal, 16).frame(minHeight: 44)
    }

    private func set(_ r: StageRole, account id: String) {
        roles.removeAll { $0.role == r }
        guard let a = model.store.account(id) else { return }
        roles.append(RoleChoice(role: r, accountID: a.id, model: a.provider.models[0].isEmpty ? nil : a.provider.models[0]))
    }

    private func set(_ r: StageRole, model m: String) {
        guard let i = roles.firstIndex(where: { $0.role == r }) else { return }
        roles[i].model = m.isEmpty ? nil : m
    }
}
