# 0014. TypeScript project references for build and typecheck

Status: Accepted — 2026-07-23

## Context

The CI pipeline ([test-plan.md](../test-plan.md) §7) runs `npm run typecheck` **before** `npm run build`, verbatim and in that order. `@backburner/api` imports `@backburner/engine`, so typechecking `api` requires `engine`'s declaration files (`dist/*.d.ts`) — which do not exist yet when `typecheck` runs, because `build` has not run. A naive per-workspace `tsc --noEmit` therefore fails in CI on a clean checkout: `api` cannot resolve `@backburner/engine`'s types.

The module boundary of [ADR 0012](0012-npm-workspaces-module-boundary.md) makes this a structural fact, not an accident — the whole point is that `api` depends on `engine`'s compiled public surface. Any typecheck strategy has to satisfy two constraints at once: no prior `build` step, and zero coupling to workspace enumeration order.

## Decision

Use TypeScript **project references** with build mode (`tsc -b`) as the single mechanism for both typecheck and build:

- Every package's `tsconfig.json` sets `composite: true` (in the shared `tsconfig.base.json`).
- `packages/api/tsconfig.json` declares `references: [{ "path": "../engine" }]`.
- A root `tsconfig.json` lists all four packages as references and is the entry point for `tsc -b`.
- Root `typecheck` is `tsc -b tsconfig.json`; it builds each project in dependency order, so `engine`'s declarations exist before `api` is checked, with no manual pre-build.
- `packages/e2e/tsconfig.json` sets `rootDir: "."` (not `src`) so both the harness (`src/`) and the suites (`test/`) are typechecked; e2e is a test-only package whose `dist/` is a typecheck by-product, never a shipped artifact.

## Alternatives considered

- **Per-workspace `tsc --noEmit`, run across workspaces.** The obvious first choice, and it fails the CI ordering constraint: `api` cannot resolve `engine`'s types before `engine` is built. Reordering CI to build-before-typecheck was rejected — the test-plan pins the step order, and typecheck-first is the right signal (a type error should fail before a slower build).
- **A pre-build step inside `typecheck`.** Building `engine` first, then `tsc --noEmit` on the rest, reintroduces exactly the build-order bookkeeping project references exist to eliminate, and does it twice (once for typecheck, once for build).
- **A single root `tsconfig` with all `src` globbed together.** Discards the package boundary at the type level — `web` could import `engine` types with nothing to stop it — directly undermining ADR 0012.

## Consequences

- One dependency graph drives both typecheck and build; adding a package edge is one `references` entry, not a script change.
- `tsc -b` emits `dist/` and `.tsbuildinfo` as a side effect of typechecking. Both are git-ignored. This is a minor departure from a literal "no emit" reading, accepted because it is the standard, correct pattern for cross-package TypeScript and no zero-emit alternative preserves the CI ordering.
- Incremental rebuilds are cached via `.tsbuildinfo`, so local `typecheck`/`build` cycles are fast.
- The e2e package's `rootDir: "."` means its `dist/` mirrors `src/` + `test/`; harmless, since nothing consumes it.
