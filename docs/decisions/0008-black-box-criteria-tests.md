# 0008. Black-box tests mapped 1:1 to the success criteria

Status: Accepted — 2026-07-21

## Context

The assessment states nine success criteria as concrete input → observable outcome checks, notes that good submissions turn them into automated tests, and says the reviewer will walk the list against the deployed app and the test suite — with restart survival and handle no-collision examined hardest. A test suite that proves internal functions work is not the same artifact as one that proves those nine sentences hold over HTTP.

## Decision

Nine named tests, `criterion-01-instant-handle` through `criterion-09-restart-durability`, live in `packages/e2e` and were written before any application code. Each test spawns the real API server as a child process (random port, dedicated test database, env overrides such as `WORKER_CONCURRENCY` and `BACKOFF_BASE_MS=100`), drives it with `fetch` and an `EventSource` client, and asserts **only** on HTTP responses and the event stream. The restart test SIGKILLs the child mid-flight and respawns it. Setup and teardown may touch SQL (truncate, seed test users); assertions never do. Waits are event-driven with timeouts — no blind sleeps.

## Alternatives considered

- **In-process server (supertest-style injection).** Faster and less orchestration, but it cannot SIGKILL a process it lives inside — the hardest criterion requires a real process boundary — and it skips the true boot path (migrations, recovery scan, dispatch kick) that criterion 9 exists to exercise.
- **Engine-level tests as the primary proof.** They validate orchestration but say nothing about the API contract, auth scoping, serialization, or event shapes — the layers the reviewer actually touches.
- **Mocked clock and database.** Fast suites, weaker claims: elapsed time *is* the substance of the instant-handle, lifecycle, cancellation, and concurrency criteria. Mock the clock and the test proves the mock.
- **Browser E2E (Playwright) as the primary suite.** Tests the UI's rendering of state, not the engine's production of it; slower, flakier, and the spec explicitly evaluates the system with the frontend deleted.

## Consequences

- The suite proves precisely what the reviewer will check, named in the reviewer's own vocabulary — the mapping from criterion to test is a filename, not a cross-reference table.
- Internal refactors cannot break these tests unless observable behavior changed; the engine, API, and schema can evolve freely underneath them.
- Real processes and real timings make the suite slower than a unit run. Mitigations: env-tunable backoff and durations, event-waits with generous CI bounds, and a separate fast unit suite in `packages/engine` for allocator edge cases, backoff math, single-flight dispatch, and serializer visibility rules.
- Writing the nine tests first turned the spec's criteria into an executable definition of done: the build is finished when they are green, and not before.
