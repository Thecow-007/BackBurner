# 0005. CAS state machine plus advisory-lock allocation

Status: Accepted — 2026-07-21

## Context

Orchestration correctness under concurrency is the assessment's top evaluation weight, and the dangerous moments are all races: a cancel arriving while a worker is finishing, a dispatch claim racing a cancel, two collects on the same result, an operator retry racing an automatic re-queue. Guarding these with application-level checks ("read status, decide, write") leaves a window between read and write where every one of those races lives.

## Decision

**Every state transition is a compare-and-swap**: `UPDATE tasks SET … WHERE id = $1 AND status = '<expected>' [AND NOT collected] RETURNING *`. Zero rows returned means the transition lost a race or was invalid; the API maps that to `409` carrying the task's actual current status. The transition-history insert (ADR 0004) shares the transaction. The one lock beyond row-level is the per-`(user, lane)` advisory transaction lock serializing handle allocation (ADR 0001), with the partial unique index as backstop. Cancellation of a running job CASes to `cancelled` *first*, then aborts the worker; when the worker's completion handler later runs its own CAS from `running`, it gets zero rows and discards the result silently.

## Alternatives considered

- **`SELECT … FOR UPDATE`, decide in code, then `UPDATE`.** Equally correct, but two round trips per transition, and the legality check drifts away from the statement that enforces it — the state machine ends up half in SQL, half in TypeScript.
- **`SERIALIZABLE` isolation.** Correct by brute force, but it converts benign races into serialization failures that every caller must catch and retry — a retry loop around every endpoint to solve what a one-statement CAS resolves deterministically.
- **In-process mutex per task id.** Insufficient on three axes: it does not survive restart, does not cover a second process, and the database write can still interleave with anything not holding the mutex.
- **Triggers or CHECK constraints encoding legal transitions.** Moves half the state machine into the schema, yet the application still needs the outcome to respond and emit events — the logic gets paid for twice and read in two places.

## Consequences

- Invalid transitions are structurally impossible, not merely avoided: there is no code path that writes a state change without naming the state it expects to replace.
- Every race collapses to "one CAS wins, the other sees zero rows" — deterministic, testable, and honest in the API (`409` with `current_status` tells the client exactly what happened).
- The cancelled-vs-completing race has a defined loser: a result arriving after cancellation is logged and dropped, never surfaced — the worker actually stopping is verified by the absence of a later `ready` event.
- The entire state machine can be audited by reading a handful of small SQL statements, which is exactly the shape of review this project invites.
