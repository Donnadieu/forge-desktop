import SwiftUI

/// The main window: setup one question at a time, then the board.
struct RootView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        Group {
            switch model.screen {
            case 0: LinearKeyScreen(model: model)
            case 1: ProjectScreen(model: model)
            case 2: GitHubScreen(model: model)
            case 3: RepoScreen(model: model)
            case 4: WorkerScreen(model: model)
            default: NotYetScreen(model: model)
            }
        }
        .frame(minWidth: 720, minHeight: 560)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

/// Stands in for the screens later steps of the plan add.
struct NotYetScreen: View {
    @ObservedObject var model: AppModel

    var body: some View {
        SetupFrame(
            model: model, question: AppModel.screenTitles[min(model.screen, 5)], detail: "This part of setup arrives in the next update.",
            primary: "Continue", primaryEnabled: false, busy: false, action: nothing
        ) { EmptyView() }
    }

    private func nothing() {}
}
