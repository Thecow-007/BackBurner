# 0006. At-least-once recovery; attempts counted at claim

Status: Accepted — 2026-07-21

## Context

Durability across restart is the second of the two hardest-checked behaviors: kill the process with jobs running and queued, restart, and every task must show its correct status with in-flight work resumed or cleanly re-queued. Two sub-problems hide inside that sentence. First, what execution guarantee do we actually offer for work interrupted mid-flight? Second, poison pills: a job whose execution crashes the process must not be re-queued into an infinite crash loop.

## Decision

`attempts` increments **at claim time**, inside the same CAS that moves `queued → running` — so a crash mid-execution has already consumed an attempt. Boot recovery scans for rows stranded in `running`: those with `attempts < max_attempts` return to `queued` (fresh `enqueued_at`, `run_after` cleared, transition event `retrying` with `meta.recovery = true`); those with the budget exhausted move to `failed` with the honest error `{ reason: "interrupted by restart; attempt budget exhausted", retryable: false }`. Dispatch then runs once. The resulting guarantee is **at-least-once execution**, and the documentation says so plainly rather than implying more.

## Alternatives considered

- **Exactly-once execution.** Requires the worker's side effects to be transactional with the engine's state — an outbox on the worker side, idempotency keys per attempt, or effects confined to the same database. Real infrastructure, real cost, and meaningless for a mock worker; documented as the upgrade path instead of half-built.
- **At-most-once (fail everything found `running`).** Never re-runs anything, but discards work a retry would have completed. For a job runner whose whole premise is reliable background completion, silently abandoning interrupted work is the wrong default.
- **Counting attempts at completion.** A job that kills the process never records its attempt: the runner re-queues it, it kills the process again, forever. Counting at claim makes the crash loop self-limiting at `max_attempts`.
- **Heartbeat/lease expiry to detect dead workers.** Necessary in a multi-process pool, where a peer must distinguish "crashed" from "slow". With one process owning every worker, boot-time recovery is exact and a heartbeat adds machinery without adding information.

## Consequences

- Restart survival is a scan plus the ordinary state machine — recovery emits real transition events, so the SSE stream and history tell the truth about what happened.
- A crash consumes an attempt: poison pills terminate in `failed` with a reason a human can act on, not a generic error and not an infinite loop.
- The honest cost of at-least-once: an interrupted job whose side effects partially happened will run again. The mock worker is trivially re-runnable; the worker contract documents that real workers must be idempotent or tolerate re-execution.
- Graceful shutdown (SIGTERM drains running workers) is kept distinct from crash recovery (SIGKILL exercises this path) — both are documented, and the criteria test exercises the crash path deliberately.
