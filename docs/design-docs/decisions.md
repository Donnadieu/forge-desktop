# Decisions

Answers to the plan's open questions (section 11). Each is the default the build uses until the owner
says otherwise.

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Triage in Linear is a per-team switch, not a status | Setup turns the team's Triage switch on through the API (`teamUpdate triageEnabled`). If Linear refuses, it creates a plain "Triage" column instead and says so. | Uses Linear's own Triage when it can; never blocks setup. |
| 2 | The key Forge makes | An SSH signing key (ed25519). The private half lives only in the Keychain and reaches git through the Mac's ssh-agent; only the public half is on disk. Registering it on GitHub changes the person's account, so the app asks first. Own GPG key and "unsigned, with a warning" stay as the other two choices. | SSH keys are the simplest to register on GitHub; the agent keeps the private half off disk. |
| 3 | GitHub sign-in for V1 | Reuse the `gh` sign-in already on the Mac. No GitHub App registration. | No account changes, nothing to register. |
| 4 | Who it's for | V1 runs on the owner's Mac. Public release stays possible (signing, notarization, updater) but isn't built for. | Ship the smallest thing that works. |
| 5 | The Linear key for agents | The Linear tools agents get carry a `${LINEAR_API_KEY}` placeholder that the agent's own environment fills, so no key is written into a card's folder. | Plan section 2: secrets only in the Keychain and the engine's environment. |
