import SwiftUI

/// The main window: setup one question at a time, then the Orchestrator, its Workflow screen and Settings.
/// Dark, in the Forge look, with the content running under a hidden title bar.
struct RootView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        Group {
            switch model.screen {
            case 0: TrackerScreen(model: model)
            case 1:
                if model.choices.board == .basecamp { BasecampProjectScreen(model: model) } else { ProjectScreen(model: model) }
            case 2: GitHubScreen(model: model)
            case 3: RepoScreen(model: model)
            case 4: WorkerScreen(model: model)
            case 5: RepoReadyScreen(model: model)
            case AppModel.workflowScreen: WorkflowScreen(model: model)
            case AppModel.settingsScreen: SettingsScreen(model: model)
            default: OrchestratorScreen(model: model)
            }
        }
        .frame(minWidth: 1100, minHeight: 680)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay(alignment: .topLeading) {
            if model.preview { TrafficLights() }
        }
        .background(Theme.bg)
        .foregroundStyle(Theme.text)
        .font(Theme.sans(13))
        .tint(Theme.heat)
        .preferredColorScheme(.dark)
        .ignoresSafeArea()
    }
}
