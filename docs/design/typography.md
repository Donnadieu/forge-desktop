# Typography: bigger, easier text

Omar, Nov 13 2026: "The font seems quite small everywhere, especially in the sessions. Orchestrator might be okay to
be that small but in general… increase the font size. Look at the Conductor. If you go to Conductor immediately, you
feel like you can read."

Built in `Sources/UI/Typography.swift` (the scale and the zoom) and `Sources/UI/Theme.swift` (fonts and colours).
Checked by `Forge --type-check` (in the selftest) and the lint rule `type-tokens`.

## 1. Measured, not guessed

Forge 0.2.42 from its code. Conductor 0.92.1 from its own stylesheet, pulled out of the app bundle (Tailwind tokens,
the chat's `prose prose-sm` classes, its dark theme) and drawn in a hidden browser with its own fonts; nothing was
opened on the screen. Omar's Conductor runs at **130% zoom** (`zoom_level_v2 = 1.3` in its settings), so what he
reads there is 1.3 times the stylesheet's size. Contrast is WCAG's ratio against the screen's background.

| Surface | Forge 0.2.42 | Conductor (stylesheet, 100%) | Conductor as Omar sees it (130%) | Forge now (100%) |
|---|---|---|---|---|
| Chat body | DM Sans 13 regular, lines 20 pt, #F7F5F1 (16.0:1) | SF Pro 14, weight 450, lines 24 (1.71), #EAE8E6 (15.4:1) | 18.2 pt, lines 31 | **DM Sans 16, lines 24 (1.5)**, #F7F5F1 (16.0:1) |
| Chat headings | 15 / 14 semibold | 19 / 17 semibold | 24.7 / 22.1 | **19 / 17** semibold |
| Code blocks | DM Mono 11, lines 14 | Geist Mono 14, lines 20 | 18.2, lines 26 | **DM Mono 14, lines 21** |
| `code` in a message | DM Mono 12 | Geist Mono 12 (0.857 em) | 15.6 | **DM Mono 14** |
| Tool rows | name DM Mono 11 #B0A99F (7.5:1); detail DM Sans 12 #7A7470 (**3.8:1**); counts mono 10 | text-sm 14, lines 20, #A5A09C (7.3:1) | 18.2 | **name DM Mono 13, detail DM Sans 14 #9A9490 (5.8:1), counts 12** |
| Message box | DM Sans 13, hint #7A7470 (3.8:1) | TipTap, body text-sm 14 / 20 | 18.2 | **DM Sans 16, lines 24**, hint 5.8:1 |
| Session header | title Playfair 26 (20 narrow), repo/branch DM Mono 11 #7A7470 | text-sm 14 / text-xs 12 | 18.2 / 15.6 | **title 28 (22 narrow)**, repo/branch DM Mono 12, 5.8:1 |
| Tabs | DM Sans 13, count mono 10 | text-sm 14 | 18.2 | **DM Sans 14, count 11** |
| Sessions sidebar | title DM Sans 13 medium, detail DM Mono 10 #7A7470, group label 11 | text-sm 14 medium, text-xs 12 muted | 18.2 / 15.6 | **title 14, detail 11, label 12**, greys 5.8:1 |
| Changes panel | header 14 semibold, file DM Mono 12, +/− 11 | file rows text-xs 12 in 32 pt rows | 15.6 | **header 15, file DM Mono 13, +/− 12** |
| Diff | DM Mono 11, numbers 10 | Pierre Diffs, text-xs 12 | 15.6 | **DM Mono 13, numbers 12** |
| Orchestrator board | titles DM Sans 13, ids DM Mono 11, table titles mono 11, notes 10.5 | (no board) | | **13.5, 11.5, 11.5, 11**: half a step, compact on purpose |
| Secondary grey | #B0A99F (7.5:1) | #A5A09C (7.3:1) | | #B0A99F (7.5:1), unchanged |
| Muted grey | #7A7470: **3.8:1** on the background, **3.1:1** on a surface | #8E8885 (5.4:1) | | **#9A9490: 5.8:1 / 4.7:1** |

Conductor's app-wide text: `text-sm` 14/20 (640 uses) and `text-xs` 12/16 (698 uses) in its interface code, body
14/20, SF Pro. DM Sans draws smaller than SF Pro at the same size (x-height 0.50 em against 0.53 em), so Forge's chat
at 16 reads about like SF Pro 15: a little larger than Conductor's stylesheet. Omar's 130% Conductor is matched by
Forge at 125% (View > Zoom In twice): DM Sans 20 in the chat, about SF Pro 19.

## 2. One type scale

Every text and icon size is a `TextSize` token (`Sources/UI/Typography.swift`). `Theme.sans/mono/display/serifItalic/
sansFont/monoFont/icon` take a token, never a number: `Theme.sans(13)` doesn't compile, and the lint rule `type-tokens`
catches the other ways in (`.system(size:)`, `NSFont(…size:)`, `Font.custom`, `.font(.body)`).

- **The app** (setup, Settings, Workflow Studio, sheets, controls and the Sessions panes' chrome): one step up.
  label 11, caption 12, small 13, body 14, emphasis 15, subtitle 16, title 17.
- **The chat** (Sessions, the biggest change): chatBody 16/24, chatHeading 19/26, chatSubheading 17/24, chatCode 14/21,
  chatTable 15/22, composer 16/24, chatText 15 (cards in the chat), chatNote 14, chatCaption 13, toolTitle 13 (mono),
  toolMeta 12 (mono), diffCode 13, diffNumber 12, terminal 13.
- **The Orchestrator** (compact): boardText 13.5, boardMono 11.5, boardSmall 11.5, boardNote 11, boardQuiet 14.5.
- **Display** (the kit's own sizes, unchanged): wordmark 20, sheetTitle 24, emptyTitle 24, codeDisplay 28 / 22,
  headline 38, pageTitle 40, stat 40; the session title grew to 28 (22 narrow).
- **Icons** keep their sizes (glyphTiny 8 to glyphXL 14) and follow the zoom.

Line heights are set only where people read paragraphs (chat, code, message box), with `Theme.lines(_:)`.

## 3. Zoom

View > Zoom In (⌘+, also ⌘=), Zoom Out (⌘-), Actual Size (⌘0). Steps 85, 90, 100, 110, 125, 150%, saved in
`UserDefaults` (`forge.zoom`) and read at launch. Every token multiplies by the zoom (half-point grid), so all text,
icons, the chat's spacing and the pane headers' height grow together; SwiftUI redraws whatever read the zoom
(`@Observable`), and the AppKit views (chat messages, message box, Terminal) rebuild at the new size. Paddings and the
window's minimum width (1100) stay in points: the panes' tiers (`ViewThatFits`) and truncation carry the larger text.
Checks and renders always draw at 100% and never save a zoom; `FORGE_ZOOM=1.5 Forge --render-screens` draws at one.

## 4. Proof

- `Forge --type-check`: the chat body is the session token at 16 with 24 pt lines, a code block 14, the message box at
  the chat size; every text colour (greys included) is 4.5:1 or better on the background and on a surface; zoom steps,
  stops at 85% and 150%, is remembered, ⌘= works, every token scales, drawn text grows; at 85% and 150% the Changes
  panel fits at its narrowest, usual and widest width, the sessions list at its narrowest and widest, every pane's
  header line meets at one height; an open window redraws at a new zoom; and the Sessions and Orchestrator (running and
  with Your turn moves) screens fit the narrowest window (1100) at 85, 100, 110 and 150%, Settings and Workflow Studio
  at 150%, read from the pixels (`topBarFitChecks`). Text only grows with the zoom, so those are the hardest step of
  each group that draws the same way (the board's card column gives way above 100%, "Open session" above 110%).
- `tools/lint/forge-lint.py`: `type-tokens` (no hard-coded size; canary in `--prove`).
- Red first: before the change the lint found 417 hard-coded sizes in 57 files; `--type-check` failed 9 (chat body
  13, no line height, code 11, the board and app steps, muted grey 3.8:1 and 3.1:1, zoom not remembered); with the new
  sizes and the old top bar, the fit check failed 10 of 24 (the Orchestrator at every zoom, Sessions from 100% up).
- Where a pane gets tight, the controls step down instead of spilling: the message box's Skills becomes its icon, then
  moves into the + menu, then the context meter steps out; the top bar drops key hints, then words beside icons, then
  the wordmark's word (`5 hours` becomes `5h`); the Running sessions table's columns grow with the zoom while the card
  title gives way, and above 110% "Open session" is its icon.
