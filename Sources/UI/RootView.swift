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
            default: BoardScreen(model: model)
            }
        }
        .frame(minWidth: 720, minHeight: 560)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}
