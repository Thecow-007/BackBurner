# 0012. npm workspaces as the module boundary

Status: Accepted — 2026-07-21

## Context

The quality bar is explicit: the engine must be a standalone module behind the documented API, the frontend a pure consumer — "we should be able to delete the frontend and still exercise the engine fully through the API." A boundary that exists only as folder convention is a boundary the first convenient import erodes. It should be enforced by the toolchain, without introducing more toolchain than a one-week, one-developer project can justify.

## Decision

An npm-workspaces monorepo with four packages and a strict dependency direction:

- `@backburner/engine` — orchestration, allocation, state machine, dispatch, recovery, events. No HTTP dependencies. Sole owner of the `tasks` and `task_transitions` tables; all SQL against them lives here.
- `@backburner/api` — Fastify server importing only the engine's public surface. Owns the `users` table for auth. Serves the built SPA in production.
- `@backburner/web` — React SPA. Speaks HTTP and SSE only; depends on neither engine nor api code, and never touches the database.
- `@backburner/e2e` — the black-box criteria suite (ADR 0008); depends on no source package, exercising the system as a child process over HTTP.

Migrations stay in a root `migrations/` directory: one schema, one runner, applied once.

## Alternatives considered

- **Single package, folder conventions.** Zero setup, but the boundary is a comment — nothing prevents a route handler importing the engine's connection pool, and erosion of exactly that kind is what the assessment warns against.
- **Separate repositories.** Maximum enforcement, and maximum friction: versioning, linking, and multi-repo CI for a solo project on a deadline. The enforcement npm workspaces provides is sufficient; the extra isolation buys nothing here.
- **pnpm / Turborepo / Nx.** Faster installs and build caching that pay off at a scale this project never reaches, while adding tool surface to a repo that must run identically on Windows, Linux CI, and Codespaces with stock npm.
- **Publishing the engine to a registry.** The strongest proof of standalone-ness, and pure ceremony for a single consumer living one directory away — `workspace` resolution proves the same import discipline.

## Consequences

- The dependency direction is machine-checked: `packages/web/package.json` has no path to the engine, so the forbidden import fails before it compiles.
- "Delete the frontend" is literally `rm -rf packages/web` — the engine, API, tests, and deployment are untouched, which is the quality bar restated as a shell command.
- The engine is host-agnostic by construction: any future process (a CLI, a second API, a webhook dispatcher) imports `createEngine` unchanged.
- One lockfile and one `npm install` keep local setup, CI, and Codespaces identical; the cost is build-order awareness (engine before api), handled once in npm scripts.
