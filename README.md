# Forge Desktop

Forge for Mac: point it at a Linear project and a GitHub repo, press Start, and one lead agent
drives the cards to merged pull requests while you watch the board.

- A native Mac app (SwiftUI), never a browser page.
- The board engine is copied from Forge and runs beside the app; see [engine/README.md](engine/README.md).
- Your keys live in your Mac's Keychain.

**Status:** scaffold. The app opens an empty window titled "Forge". Nothing else is built yet.

## Build

    cp .env.example .env    # fill in the commit identity (contributors only)
    make hooks              # once per clone
    make build              # build/app.noindex/Forge.app
    make check              # the whole gate

Needs macOS 14+ on Apple Silicon, the Xcode command line tools, and Node 22 + pnpm for the engine.

Agents and contributors start at [AGENTS.md](AGENTS.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
