# Workspaces: many trackers, projects, repos and intelligence providers

Status: **design**, waiting for Omar's yes before any code. Design: [workspaces-design.md](workspaces-design.md).

## The request (Omar, Nov 5 2026, dictated; cleaned up, meaning unchanged)

> We need a new feature for Forge. What if I want to manage multiple boards, or multiple projects?
>
> Think about it like a relational database: it starts from the top. Normally the user would be first; we don't have
> users, but the person comes first. From there you can "add a new project" or "add a new workflow" (I don't know what
> to call it yet). It's not an "account". We have to come up with a name, but it represents the tracker, the project,
> the GitHub repo, the intelligence provider and Harness engineering, together.
>
> You do the whole setup again for a new one, and you can have as many as you like. There's a screen where you can
> handle them and move between them. I'm calling it "project" for now, but we can call it something else: give me
> options.
>
> For example, right now I'm in ConstructEase, using one project there. First requirement: I go to Settings and add
> several trackers. Right now I have Basecamp connected. I should be able to connect Linear and GitHub Issues too, and
> several of each: two different Linears, two different Basecamps, two different GitHub Issues.
>
> GitHub Issues is a bit different, because it goes one-to-one with the repo, so we have to think about that.
>
> A tracker has several projects. Today there's a dropdown; it should be a multi-select: which projects do you want
> Forge to manage?
>
> Think about migration first. What if I also want to manage Dev Chat, or other projects? I can connect them. That
> maps to the tracker. We need a place where I select projects and map them to the tracker: this tracker manages these
> projects. There's a natural hierarchy, since a tracker has projects underneath it.
>
> Then GitHub: I should be able to pick different GitHub accounts and add more. It recognises two today; I should be
> able to add more. Repos are the same, but a repo can't live on its own: it has to be linked to a project, so the
> settings may have to change. A project maps to a repo. The tracker has many projects, and a project maps to one repo.
>
> The intelligence provider: you can assign it to a project, so that project is run by that provider, with a model
> like Sonnet. But I don't want to limit it. The intelligence provider floats on its own; it's a canonical thing,
> because I want to attach several intelligence providers to one project. I might use Claude for coding and AI review,
> and Codex for execution. We want that in the future, so a project can have many intelligence providers. Harness
> engineering applies to a particular GitHub repo.
>
> It's a big change. Design first. Ask me if you have questions.

Earlier the same day (the request that led to 0.2.17, several accounts per provider): "Tracker naturally has projects,
but I can map a project to a specific GitHub repo. A project has an intelligence provider (call it an intelligence
provider, never an agent): Claude Code, Codex, Kimi or OpenRouter. In Settings › Intelligence provider I can add
several accounts, with OAuth or an API key, and several API keys."

## Requirements

**R1. A top-level unit, many of them.** It bundles tracker connections, the projects Forge manages, GitHub accounts and
repos, intelligence providers and Harness engineering. Create, edit, rename and delete one. One screen lists them and
switches between them. Name: three options with a recommendation (see the design: **Workspace**).

**R1b. Workspaces run in parallel** (Omar's feedback on the first design, Nov 5): as many workspaces running at once as
he likes, each started and stopped on its own; looking at one never stops another.

**R2. Several tracker connections of each kind.** Two Linears, two Basecamps, two GitHub Issues, each its own sign-in,
none signing another out. Under each connection, a multi-select of the projects Forge manages (for example
ConstructEase Rails Migration and Dev Chat), replacing today's single dropdown.

**R3. GitHub Issues is one-to-one with a repo.** A GitHub Issues board files its issues in one repo, and that repo is
the project's code repo. The repo mapping shows it fixed rather than as a choice.

**R4. Several GitHub accounts.** Both accounts the GitHub CLI already has on this Mac show up, and more can be added.
Each repo is reached through one of them.

**R5. A project maps to one repo.** A tracker has many projects; each project maps to exactly one repo. A repo can't
exist on its own in Settings: it's always reached through a project.

**R6. Intelligence providers stand alone, many-to-many with projects.** An account (sign-in or key) belongs to the Mac,
not to a project. A project can use several, each with a role (for example Claude Code for building and AI Review,
Codex for another stage), and a model picked per role (Sonnet, Opus...).

**R7. Harness engineering per repo.** Each repo keeps its own guardrail record (read, proposed, in a card, landed).

**R8. Migration first.** What's installed today (0.2.17: one Basecamp project, ConstructEase Rails Migration, on
ConstructEase/constructease, Claude Code account "Constructease", plus the Linear key and both GitHub CLI accounts)
must carry over by itself, with nothing to redo and nothing signed out.

**R9. Design first.** Data model, migration, settings flow and navigation, and screens in Forge's current look. No
code until Omar says yes.

## Not in this request

- Per-stage agents and models need the engine to pick a different provider per stage. They are designed here (roles)
  but built last, as their own step, because they change how the engine runs.
- Jira stays postponed.
