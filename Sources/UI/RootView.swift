import SwiftUI

/// The empty main window. Setup and the board come in later steps (see docs/exec-plans).
struct RootView: View {
    var body: some View {
        Color(nsColor: .windowBackgroundColor)
            .frame(minWidth: 720, minHeight: 480)
    }
}
