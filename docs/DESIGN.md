# Design

- A native Mac window titled **Forge**, built in SwiftUI. Standard Mac behavior first: the menu bar,
  keyboard shortcuts, sheets. The title bar is hidden so the content runs under it; the window keeps
  its own buttons.
- One main screen: the Orchestrator. Setup is a short sequence of single questions, not a form, with the
  steps listed down a sidebar.
- Each card says in one plain line what's happening ("Writing tests for the login page").
- A failed check shows its problem line and, right under it, the one button that fixes the cause.
- Before a new screen ships, render it (`Forge --render-screens <folder>`) and look at the picture; an
  agent can't see the live window.

## The look (Forjado AI design system)

Every colour, font and control comes from `Sources/UI/Theme.swift` and `Sources/UI/Controls.swift`
(and `Choices.swift` for radio rows, segmented choices and checkboxes). Never use stock colours
(`.accentColor`, `.green`, `.orange`) or system fonts on a screen.

- **Colours:** warm near-black background `#1C1A17`, surfaces `#2E2B27`, cream text `#F7F5F1`, and
  amber heat `#C47F2A` / `#E59B47` as the only saturated accent. Amber means "live" or "act here":
  the main button, a working card, a fix button.
- **Type:** Playfair Display for screen titles and the project name, DM Sans for everything people
  read, DM Mono for labels, card numbers, branches and keys. The fonts ship in `Resources/Fonts`
  (SIL Open Font License, licences beside them) and are registered at launch; the selftest checks
  they load. Every size is a token from one scale (`Sources/UI/Typography.swift`, design in
  [design/typography.md](design/typography.md)): the chat reads at 16 pt with 1.5 lines, the app one step up from
  0.2.42, the Orchestrator compact. View > Zoom scales all of it (85 to 150%, remembered). Grey text is never under
  4.5:1 on the background or a surface.
- **Mark:** the Forjado AI anvil (`AnvilMark`), drawn from the brand's SVG.
- **App icon:** the amber anvil on a warm near-black rounded square, made in Claude Design (project
  "Forge Desktop", files `Forge App Icon.svg` and `Forge App Icon small.svg`). The SVGs and their PNG
  exports live in `Resources/AppIcon`; `build.sh` turns the `AppIcon.iconset` (64 to 1024 px) into
  `AppIcon.icns` with `iconutil`. No 16 or 32 px pictures: the small SVG's art fills more of its square
  than macOS 26's icon grid allows, so macOS shrinks it onto a light plate; macOS scales the 64 px picture
  down instead. Stage Manager and the Dock ask macOS for the icon by bundle id, and macOS keeps that
  picture even after the app changes: a Mac that once registered a Forge build without an icon showed a
  blank white tile there. Forge checks at launch and asks macOS to clear its icon cache when that picture
  isn't the anvil (`SystemIcon` in `Sources/App/AppIcon.swift`). `Forge --icon-check` (in the selftest and
  in `package-app.sh`) checks every size, what Finder draws, and what macOS hands Stage Manager, light and
  dark. To change the icon, change the SVGs in Claude Design and export every size again.
- **Shape:** radii 2 / 4 / 8 / 14 / pill, spacing in 4 px steps, one soft shadow, an amber glow only
  on work that's running.
- **Sizes:** where the design system's UI kit sets a size (Orchestrator headline 38, stat numbers 40,
  page titles 40, eyebrows 10), use the kit's value, not the nearest token.
- **Top bar** (`TopBar` in `Shell.swift`): the anvil and "Forge" clear of the traffic lights, the
  screen's name in mono, then that screen's buttons on the right. Usage (a plan's windows) only here.
- **Orchestrator:** the headline says what's in flight; four stats; then tables, never Linear
  columns. When the board has no cards, one block fills the page: the anvil, "Nothing on the anvil
  yet", and the one button that helps. Stage colours show as pills and dots, never as a legend.
- **Workflow:** one list of the ten stages, a toggle on the optional ones, and agents at once.

The source design lives in Claude Design: project "Forge Desktop redesign"
(claude.ai/design/p/bd04aa5f-2682-4d6e-9091-f4031813f2b5), made with the "Forge Design System"
(claude.ai/design/p/019e0898-6eb6-7126-8766-9d465da3ad23). `forge-kit.css` there is the build spec.
