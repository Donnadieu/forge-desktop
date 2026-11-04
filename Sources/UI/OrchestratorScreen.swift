import SwiftUI

/// The Orchestrator (the Orchestrator kit): one top bar, the headline with what's in flight, four stats,
/// then tables of the cards (OrchestratorTables). Live state is pushed by the engine; nothing is polled here.
struct OrchestratorScreen: View {
    @ObservedObject var model: AppModel
    @ObservedObject private var updater = Updater.shared
    @State private var open: EngineState.Card?
    @State private var busy = false
    @State private var guideOpen = false
    @StateObject private var signIn = AgentSignIn()
    /// The sign-in already opened by itself for this lapse (once, so closing it isn't undone).
    @State private var signInOffered = false

    private var state: EngineState? { model.engine }
    private var project: String { model.choices.projectName ?? "your project" }
    var problem: String? { model.engineProblem ?? state?.board?.problem ?? signedOutLine }

    var body: some View {
        VStack(spacing: 0) {
            TopBar(suffix: "Orchestrator") { navRight }
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    header
                    if let problem { notice(problem) }
                    StatsRow(state: state)
                    OrchestratorTables(model: model, state: state, open: $open)
                        .opacity(problem != nil ? 0.4 : 1)
                        .allowsHitTesting(problem == nil)
                }
                .padding(.horizontal, 32)
                .padding(.top, 32)
                .padding(.bottom, 24)
                footer
            }
        }
        .background(Atmosphere())
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .task {
            let restart = model.settingsChanged
            model.settingsChanged = false
            await model.link.connect(restart: restart)
            // `open -a Forge --args --start`: press Start once the board is up (the same call the button makes).
            if CommandLine.arguments.contains("--start"), state?.isRunning == false { await model.link.start() }
        }
        .sheet(item: $open) { card in
            CardDetail(model: model, card: state?.cards.first { $0.id == card.id } ?? card) { open = nil }
        }
        .overlay { if guideOpen { SignInGuide(worker: agent, signIn: signIn, close: closeGuide) } }
        .onChange(of: signIn.stage) { _, stage in
            if stage == .done {
                guideOpen = false
                signInOffered = false
                // The agents' sign-in is read when the engine starts: restart it, and the card goes again.
                Task { await model.link.connect(restart: true) }
            }
        }
        .onChange(of: signedOutLine) { _, line in
            // Signed out: open the sign-in by itself, once. The person only approves it in the browser.
            // Cards blink between running and waiting, so the line comes and goes: offer it once until signed in.
            guard line != nil, !signInOffered, !guideOpen, !model.preview, AgentSignIn.command(for: agent) != nil else { return }
            signInOffered = true
            openGuide()
        }
    }

    // MARK: Top bar

    @ViewBuilder private var navRight: some View {
        HStack(spacing: 12) {
            statusPill
            UsageLine(state: state)
            if state?.rate_limits?.isEmpty == false { Rectangle().fill(Theme.border).frame(width: 1, height: 20) }
            if let rel = updater.available, !model.preview {
                Button(updater.installing ? "Updating…" : "Update to \(rel.version)") { Task { await updater.install() } }
                    .buttonStyle(ForgeButton(kind: .secondary, icon: "arrow.down.circle"))
                    .disabled(updater.installing)
                    .help(updater.problem ?? "Agents finish what they're doing, then Forge restarts on the new version.")
            }
            Button("Workflow Studio") { model.go(AppModel.workflowScreen) }
                .buttonStyle(ForgeButton(kind: .ghost, icon: "point.topleft.down.to.point.bottomright.curvepath"))
            Button("Settings") { model.go(AppModel.settingsScreen) }
                .buttonStyle(ForgeButton(kind: .ghost, hint: "⌘,", icon: "gearshape"))
                .keyboardShortcut(",", modifiers: .command)
            if state?.isRunning == true || state?.status == "stopping" {
                Button("Stop") { act { await model.link.stop() } }
                    .buttonStyle(ForgeButton(kind: .secondary, hint: "⌘.", icon: "stop.fill"))
                    .keyboardShortcut(".", modifiers: .command)
                    .disabled(busy || state?.status == "stopping")
            } else {
                Button("Start") { act { await model.link.start() } }
                    .buttonStyle(ForgeButton(kind: isEmpty ? .secondary : .primary, hint: "↵", icon: "play.fill"))
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || state == nil)
            }
        }
    }

    @ViewBuilder private var statusPill: some View {
        let n = state?.running.count ?? 0
        if state?.isRunning == true {
            Pill(text: "\(n) agent\(n == 1 ? "" : "s")", tone: n > 0 ? .heat : .neutral, dot: n > 0 ? Theme.heat : Theme.textMuted, pulsing: n > 0)
        } else if state?.status == "stopping" {
            Pill(text: "Stopping…", tone: .amber, spinning: true)
        } else if state == nil {
            Pill(text: "Starting…", spinning: true)
        } else {
            Pill(text: "Stopped", dot: Theme.textMuted)
        }
    }

    // MARK: Header

    private var inFlight: Int { state?.running.count ?? 0 }
    private var isEmpty: Bool { state != nil && (state?.cards.isEmpty ?? true) }

    private var header: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: "\(project) · Linear")
            HStack(spacing: 12) {
                if state == nil {
                    Text("Reading your board…").foregroundStyle(Theme.text)
                    Spinner()
                } else {
                    (Text("On the anvil — ").foregroundColor(Theme.text)
                        + Text("\(inFlight) card\(inFlight == 1 ? "" : "s")\(inFlight > 0 ? " in flight" : "")")
                        .foregroundColor(inFlight > 0 ? Theme.heat : Theme.textSec))
                }
            }
            .font(Theme.display(38))
            .padding(.top, 8)
            Text(lead).font(Theme.sans(13)).foregroundStyle(Theme.textSec).padding(.top, 8)
            HStack(spacing: 8) { metaPill }.padding(.top, 12)
        }
    }

    private var lead: String {
        guard let s = state else { return "Forge is reading \(project) from Linear." }
        switch s.status {
        case "running": return "Everything your agents are working on in \(project)."
        case "stopping": return "Stopping: agents finish what they're doing first."
        default: return isEmpty ? "Nothing to work on in \(project) yet." : "Stopped. Press Start to let agents take cards."
        }
    }

    @ViewBuilder private var metaPill: some View {
        if problem != nil, problem != model.engineProblem {
            Pill(text: "Paused", tone: .amber, dot: Theme.heat)
        } else if state?.isRunning == true {
            Pill(text: "Live", tone: .heat, dot: Theme.heat, pulsing: true)
        } else if state?.status == "stopping" {
            Pill(text: "Stopping", tone: .amber, spinning: true)
        } else if state != nil {
            Pill(text: "Stopped", dot: Theme.textMuted)
        }
    }

    // MARK: Problems

    /// The agent's sign-in lapsed: cards wait to try again with a sign-in error.
    private var signedOutLine: String? {
        guard let errors = state?.retrying?.compactMap(\.error), errors.contains(where: AgentSignIn.looksSignedOut) else { return nil }
        return "\(WorkerScreen.name(agent)) is signed out, so agents can't take cards."
    }

    private var agent: SetupChoices.Worker { model.choices.worker ?? .claude }

    private func notice(_ text: String) -> some View {
        Notice(
            title: text,
            detail: Self.noticeDetail(text, signedOutLine: signedOutLine, appProblem: model.engineProblem)
        ) {
            if text == signedOutLine, AgentSignIn.command(for: agent) != nil {
                Button("Sign in to \(WorkerScreen.name(agent))") { openGuide() }
                    .buttonStyle(ForgeButton(kind: .primary, large: true))
                    .padding(.leading, 26)
            } else if let fix = Self.fix(for: text) {
                Button(fix.title) { fix.isLink ? model.openLink(fix.target) : model.change(0) }
                    .buttonStyle(ForgeButton(kind: .primary, icon: fix.isLink ? "arrow.up.right" : nil, large: true))
                    .padding(.leading, 26)
            }
        }
    }

    /// The line under a problem. Only the engine's own problems (Linear, sign-in) clear by themselves on its next try;
    /// a problem the app hit talking to the engine says what to press in its own line, so nothing goes under it.
    static func noticeDetail(_ text: String, signedOutLine: String?, appProblem: String?) -> String? {
        if text == signedOutLine { return "Forge opened the sign-in for you. Cards start again once you approve it." }
        return text == appProblem ? nil : "Forge tries again by itself."
    }

    /// The one fix for the problems Forge recognizes; nil when there's nothing to press.
    static func fix(for problem: String) -> (title: String, target: String, isLink: Bool)? {
        let p = problem.lowercased()
        if p.contains("didn't accept this key") { return ("Change the Linear key", "", false) }
        if p.contains("linear said") && (p.contains("usage limit") || p.contains("plan")) {
            return ("Open your Linear plan", "https://linear.app/settings/billing", true)
        }
        return nil
    }

    private func openGuide() {
        guideOpen = true
        if model.preview { return }
        Task { await signIn.start(agent) }
    }

    private func closeGuide() {
        signIn.cancel()
        guideOpen = false
    }

    // MARK: Footer

    private var footer: some View {
        VStack(spacing: 16) {
            Rectangle().fill(Theme.border).frame(height: 1)
            HStack(spacing: 12) {
                Text(readLine)
                Text("·").opacity(0.5)
                Button("Open in Linear ↗") { model.openLink(model.projectURL) }.buttonStyle(ForgeButton(kind: .plain))
                Spacer()
            }
            .font(Theme.mono(11))
            .foregroundStyle(Theme.textMuted)
        }
        .padding(.horizontal, 32)
        .padding(.bottom, 24)
    }

    private var readLine: String {
        guard let at = state?.board?.read_at, let d = ISO8601DateFormatter.withFraction.date(from: at) ?? ISO8601DateFormatter().date(from: at)
        else { return state == nil ? "Reading the board…" : "Board read just now" }
        let m = Int(Date().timeIntervalSince(d) / 60)
        return m < 1 ? "Board read just now" : "Board read \(m) min ago"
    }

    private func act(_ f: @escaping () async -> Void) {
        busy = true
        Task {
            await f()
            busy = false
        }
    }
}

/// Usage in the top bar: a Claude plan's windows ("5 hours 42% · Week 18%"). Tokens are in the stats, not here.
struct UsageLine: View {
    let state: EngineState?

    var body: some View {
        if let limits = state?.rate_limits, !limits.isEmpty {
            HStack(spacing: 6) {
                ForEach(Array(limits.keys.sorted().enumerated()), id: \.element) { i, k in
                    if i > 0 { Text("·").foregroundStyle(Theme.textMuted) }
                    Text(Self.windowName(k)).foregroundStyle(Theme.textMuted)
                    Text(limits[k]?.percent.map { "\($0)%" } ?? "in use").foregroundStyle(Theme.text)
                }
            }
            .font(Theme.mono(11))
            .fixedSize()
        }
        // Without a plan's windows there is nothing to add here: tokens today are in the stats below.
    }

    static func windowName(_ k: String) -> String {
        switch k {
        case "five_hour": return "5 hours"
        case "seven_day": return "Week"
        case "seven_day_opus": return "Week (Opus)"
        case "seven_day_sonnet": return "Week (Sonnet)"
        default: return k.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    static func short(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1e6) }
        if n >= 1000 { return String(format: "%.1fK", Double(n) / 1000) }
        return "\(n)"
    }
}
