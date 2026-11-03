# Design

- A native Mac window titled **Forge**, built in SwiftUI. Standard Mac behavior first: the title bar,
  the menu bar, keyboard shortcuts, dark mode.
- One main screen: the board. Setup is a short sequence of single questions, not a form.
- Each card says in one plain line what's happening ("Writing tests for the login page").
- Before a new screen ships, render it (`--render-<screen>` check mode, added with the first screen)
  and look at the picture; an agent can't see the live window.
