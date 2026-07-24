# 0015. Additive e2e harness helpers beyond the test-plan surface

Status: Accepted — 2026-07-23

## Context

[test-plan.md](../test-plan.md) §3 is normative for the e2e harness: it enumerates the wait helpers (§3.5), the timing constants (§3.6), and the server/DB lifecycle. Two gaps surfaced while wiring the nine criteria tests against that surface — both cases where following the test-plan's own rules required a helper the test-plan did not itself list. Under the working agreements ([build-plan.md](../build-plan.md)), any addition to a doc-normative surface is recorded, even when it is purely additive.

## Decision

Two additive helpers in `packages/e2e/src/`, neither altering an existing signature:

1. **`EventCapture.ready: Promise<void>`.** Every criterion connects the SSE stream *before* the first submit (§4 intro: "ES" means connected first) precisely so no event is missed. But `new EventCapture(...)` returns synchronously while the underlying `EventSource` connection opens asynchronously — a submit issued in the gap can land before the server has attached the subscriber, and the `accepted` event is lost. `ready` resolves when the connection opens (bounded by `T_BOOT`, with the same log-tail diagnostics as every other wait), so tests `await capture.ready` before their first submit. This closes a harness race, which the flakiness policy (§9) classifies as a bug to fix, not a wait to widen — and which Gate A forbids (tests must fail from missing implementation, not harness defects).

2. **`T_COMPLETION_SPAN = 2000` in `timing.ts`.** Criterion 08's premise check ("the three `ready` arrivals span < 2 s", §4.8) is a bound in §4 whose value §3.6's table happens not to name. §3.6's own rule is that *every* bound in §4 lives in `timing.ts` by name. Adding the constant brings the suite **into** compliance with §3.6 rather than departing from it; it is recorded here only because it extends the enumerated constant set.

## Alternatives considered

- **Poll or sleep before the first submit** instead of `ready`. A blind sleep is forbidden by §3.6 rule 1; a poll is a busy-wait with no bound. An awaitable open is the direct, event-driven expression of "connected first."
- **Bake `2000` inline in criterion 08.** Leaves a bare timing literal in a test file, violating §3.6, and hides a spec bound from the one file meant to hold all of them.
- **Amend test-plan.md §3.5/§3.6 in place.** The design docs are treated as stable law; a code-level additive helper with an ADR is the sanctioned way to extend them, not a silent edit to the normative text.

## Consequences

- The nine criteria tests are deterministic against the connect race — no criterion can flake by losing `accepted` to a slow stream open.
- The harness surface reported to the criteria-test authors stays stable: `ready` is additive, and no existing method (`waitFor`, `waitForCount`, `assertNever`, `all`, `close`) changed.
- `timing.ts` remains the single source of every e2e timing bound, so a CI-slack or spec-bound change stays a one-line, reviewable diff.
