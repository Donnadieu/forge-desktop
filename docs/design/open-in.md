# Open in…: open a session's folder in an app on the Mac

Status: **built, Direction A (Omar's pick, Nov 12, 2026).** Code: `Sources/Core/OpenIn.swift` (catalog, detection,
folder rule, launch plans, per-workspace default), `Sources/UI/OpenInButton.swift` (model, split button, menu); checks
`Sources/App/OpenInChecks.swift`; renders `21-open-in-*` (copies in `docs/design/open-in/built/`). Claude Design project
<https://claude.ai/design/p/998653e1-6c33-4e48-a23c-180cbc5c5e35>. Pictures in `docs/design/open-in/` (`00-conductor-reference.png`, `s0` today, `a1`-`a7`, `b1`-`b7`).

Omar's words: "the ability to open the code of that particular workspace in that tree, in a terminal in an IDE.
Detecting what IDEs they have and then showing them a list, kind of like what Conductor does." Builds on Sessions
(`docs/design/sessions.md`) and the sidebar/PR panel round (`docs/design/sidebar-pr-panel.md`). Nothing here touches
the board engine.

## 1. What Conductor does (0.92.1, read from its own UI bundle)

| Part | Conductor |
|---|---|
| Apps it knows | 38: Finder, Cursor, VS Code, Zed (+Preview, Nightly), VSCodium, Devin, Sublime Text, the JetBrains IDEs, Android Studio, Xcode, Trae, Antigravity, Ghostty, Alacritty, iTerm, WezTerm, Warp, Hyper, Terminal, GitHub Desktop, Sourcetree, Fork, Kaleidoscope |
| Detection | By app **name**: `/Applications/<Name>.app` or `~/Applications/<Name>.app`. Finder and Terminal always listed |
| Icons | Its own bundled PNGs (a generic one for most JetBrains), replaced by the real icon: `defaults read …/Info CFBundleIconFile` then `sips` to a 128 px PNG cache |
| Control | Split button: the default app's icon opens in one click; the chevron opens "Open in..." (installed apps, icon + name, number keys 1-9, the default one shows ⌘O), then "Copy path". Tooltip "Open in <App> ⌘O" |
| Default | One global setting, `default_open_in` = the app used last. None yet: Cursor if installed, else Finder |
| Shortcut | `workspace.openInApp` = ⌘O |
| Launch | Editors with a CLI run it (`cursor <folder> --goto file:line`, `code`, Zed's `cli`, `xed -l` for Xcode); the rest, terminals included, `open -a "<App>" <folder>`; Finder `open <folder>` |
| Failure | A toast "Failed to open in <app>: <reason>" |

What we keep: only installed apps, real icons, the split button, ⌘O, Copy path, "the last one you used is the default".
What we change: detection by **bundle id** (`NSWorkspace.urlForApplication(withBundleIdentifier:)`), so a renamed or
moved app is still found and a same-name app isn't mistaken for it; the default is remembered **per workspace** (Omar's
ask), not Mac-wide; no first-time guess (the first click shows the list); the folder is always the session's own
worktree, never the repo's main checkout.

## 2. What Forge has today (0.2.38)

- The session header (`ChatColumn.swift`): Playfair title, status pill, then on the right a ghost "Terminal ⌃`"
  button (the in-app shell, `TerminalPanel`); the mono line repo · branch · who started it; the chat tabs.
- `Sessions.Session.folder` is the session's own folder: a chat's worktree, or for a card's session the running card's
  workspace. It is the only path this feature opens.
- Nothing opens a session in another app today; people copy the path from the terminal.

## 3. The two directions

Both: the same detection, the same menu (EDITORS, TERMINALS, then Finder and GitHub Desktop; Copy path at the bottom
with the folder in dim mono), the same per-workspace default with ⌘O, "Opened in Cursor" for two seconds after a click,
and one Notice with "Choose another app" when an app fails to open.

- **A, "In the header":** a split ghost button on the title row, left of "Terminal". The two ways out of Forge sit
  together. Compact (two chats side by side): icon + chevron only.
- **B, "With the code":** the split button sits on the Changes panel's "36 files changed" line, and each file row shows
  the default app's tiny icon on hover to open that file; right-click on a file lists the apps.

Recommendation: **A.** It's one control in one place, next to the Terminal button it belongs with, and it still works
with the Changes panel hidden. B's per-file opening is a nice extra that can come later on top of A.

## 4. Apps and how each opens

| App | Bundle id(s) | Kind | Opens with |
|---|---|---|---|
| Cursor | com.todesktop.230313mzl4w4u92 | editor | the folder, through Launch Services (`open -a`) |
| VS Code | com.microsoft.VSCode, com.microsoft.VSCodeInsiders | editor | same |
| Windsurf | com.exafunction.windsurf | editor | same (on Omar's Mac this id is "Devin"; the menu shows the app's own name) |
| Zed | dev.zed.Zed, dev.zed.Zed-Preview | editor | same |
| Xcode | com.apple.dt.Xcode | editor | same |
| Sublime Text | com.sublimetext.4, com.sublimetext.3 | editor | same |
| Nova | com.panic.Nova | editor | same |
| RubyMine, WebStorm, IntelliJ IDEA (+CE), PyCharm (+CE), GoLand | com.jetbrains.rubymine, com.jetbrains.WebStorm, com.jetbrains.intellij(.ce), com.jetbrains.pycharm(.ce), com.jetbrains.goland | editor | same |
| Terminal | com.apple.Terminal | terminal | the folder: a new window there |
| iTerm2 | com.googlecode.iterm2 | terminal | same |
| Warp | dev.warp.Warp-Stable | terminal | same |
| Ghostty | com.mitchellh.ghostty | terminal | a new instance with `--working-directory=<folder>` (Ghostty ignores an opened folder) |
| Finder | com.apple.finder | other | shows the folder |
| GitHub Desktop | com.github.GitHubClient | other | the folder (adds the repo if new) |

Only apps whose bundle id resolves are listed, in this order within each group.

## 5. As built

- The menu has no ⌘1-9 hints: on the Sessions screen ⌘1-9 already open sessions 1-9.
- ⌘O replaces the old hard-wired "Cursor, then VS Code, else Finder" (`SessionsModel.openInEditor`, removed).
- Windsurf's bundle id now installs as "Devin": that entry shows the app's own name (`App.ownName`).
- A failed open shows the Notice under the header with "Choose another app"; a refused folder (none, or a main
  checkout) says "This session has no folder of its own to open."

## 6. Build plan (as planned)

- `Core/OpenIn.swift`: the catalog, `AppFinder` (a protocol over `urlForApplication(withBundleIdentifier:)`), the
  per-workspace default (`UserDefaults`, key per workspace id), and `OpenIn.plan(app:folder:)` returning what to launch.
  Pure; tested with a fake registry and a recording launcher. Never launches anything in a check.
- `UI/OpenInButton.swift`: the split button and menu from the picked direction; ⌘O on the Sessions screen.
- Tests first (selftest checks): detection lists only what the fake registry has; the folder passed is
  `session.folder`, never the repo root, for chat and card sessions; the default is remembered per workspace and two
  workspaces don't share it; each kind gets its launch plan (open with, new instance with arguments, Finder).
