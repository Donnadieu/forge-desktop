# Design

- A native Mac window titled **Forge**, built in SwiftUI. Standard Mac behavior first: the menu bar,
  keyboard shortcuts, sheets. The title bar is hidden so the content runs under it; the window keeps
  its own buttons.
- One main screen: the board. Setup is a short sequence of single questions, not a form, with the
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
  they load.
- **Mark:** the Forjado AI anvil (`AnvilMark`), drawn from the brand's SVG.
- **App icon:** the amber anvil on a warm near-black rounded square, made in Claude Design (project
  "Forge Desktop", files `Forge App Icon.svg` and `Forge App Icon small.svg`, the small one tuned for
  16 and 32 px). The SVGs and their PNG exports live in `Resources/AppIcon`; `build.sh` turns the
  `AppIcon.iconset` into `AppIcon.icns` with `iconutil`, and the selftest checks macOS draws the anvil
  for the built bundle. To change it, change the SVGs in Claude Design and export every size again.
- **Shape:** square-ish corners (4 to 8), surfaces and spacing instead of outlines, one soft shadow,
  an amber glow only on work that's running.
- **Board:** columns with cards share the width; empty columns fold into thin strips so all ten fit.
  Each card has one status word: Working, Your turn, Up next, Later or Done.

The source design lives in Claude Design (project "Forge Desktop", using the "Forge Design System").
