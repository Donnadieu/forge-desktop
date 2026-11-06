import SwiftUI

/// Who works a stage, on its own row in Workflow Studio: one list with "Default provider" and every account on this
/// Mac with each of its models. The pick is a role (`RoleChoice`); stages no role takes use the project's default
/// provider (setup 5). Design: Claude Design project 5cb71ba1, frame s1 (Omar picked Direction A, Nov 5 2026).
struct StageWorkerPicker: View {
    @ObservedObject var model: AppModel
    @Binding var roles: [RoleChoice]
    let role: StageRole

    var body: some View {
        Picker("", selection: Binding(get: key, set: set)) {
            Text("Default provider").tag("")
            ForEach(IntelligenceProvider.allCases, id: \.self) { p in
                let list = model.store.accounts(for: p)
                if !list.isEmpty {
                    Divider()
                    ForEach(list) { a in
                        ForEach(p.models, id: \.self) { m in Text(Self.label(a, model: m)).tag(RoleChoice.pickKey(a.id, m)) }
                    }
                }
            }
        }
        .labelsHidden()
    }

    /// "Codex · ChatGPT Pro", or "Claude Code · ConstructEase · opus-5" when the provider offers several models.
    static func label(_ a: AIAccount, model m: String?) -> String {
        let base = "\(a.provider.name) · \(a.name)"
        guard let m, !m.isEmpty, a.provider.models.count > 1 else { return base }
        return "\(base) · \(short(m))"
    }

    /// "claude-opus-5" and "anthropic/claude-opus-5" read as "opus-5" next to the provider's name.
    static func short(_ m: String) -> String {
        var s = m
        for p in ["anthropic/", "claude-"] where s.hasPrefix(p) { s.removeFirst(p.count) }
        return s
    }

    private func key() -> String {
        guard let c = roles.first(where: { $0.role == role }), let a = model.store.account(c.accountID) else { return "" }
        return RoleChoice.pickKey(a.id, c.model ?? a.provider.models[0])
    }

    private func set(_ k: String) {
        roles.removeAll { $0.role == role }
        if let c = RoleChoice.picked(k, role: role), model.store.account(c.accountID) != nil { roles.append(c) }
    }
}

/// The project's default provider and model, shown once at the top of Workflow Studio's side panel.
struct DefaultProviderLine: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let a = model.account {
                Text("\(a.provider.name) · \(a.name)").font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
                Text(model.choices.model ?? "its usual model").font(Theme.mono(11)).foregroundStyle(Theme.textSec)
            } else {
                Text("None yet").font(Theme.sans(13)).foregroundStyle(Theme.textMuted)
            }
        }
    }
}
