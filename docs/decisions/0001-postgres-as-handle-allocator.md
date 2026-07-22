# 0001. Postgres as the handle allocator

Status: Accepted — 2026-07-21

## Context

Handles (`scrape-1`) are per-user, per-lane, human-friendly, and recyclable: a number is released when its job is collected or cancelled, and must never collide with an active job. The assessment names handle recycling without collision as one of the two behaviors it verifies most carefully, alongside restart survival. Whatever knows "which numbers are currently held" must therefore be correct under concurrent submits *and* survive a process kill — the two requirements compound.

## Decision

There is no allocator state. The `tasks` table **is** the allocator. "Active" (holds its handle) is a single predicate — `status IN ('queued','running') OR (status IN ('ready','failed') AND NOT collected)` — encoded as a partial unique index on `(user_id, lane, handle_num)`. Submission runs one transaction: take `pg_advisory_xact_lock` keyed on `(user_id, lane)`, query the lowest positive integer not held by an active task, insert the row. The partial unique index is the structural backstop: a unique violation (which should be impossible under the lock) triggers a bounded retry rather than a corrupt handle.

## Alternatives considered

- **In-memory allocator (per-lane counter or bitmap), rebuilt from the DB at boot.** Fastest path per submit, but it creates a second source of truth: a crash between the insert and the in-memory update leaks or collides a number, rebuild bugs corrupt allocation silently, and it is useless the moment a second process exists.
- **Dedicated `handles` lease table.** Explicit, but it duplicates state the tasks table already implies. Every acquire and release becomes two writes that must stay in lockstep, and drift between lease row and task row is a new failure class with no compensating benefit.
- **Monotonic per-lane counter, no recycling.** Trivially collision-free and trivially wrong: recycling is a spec requirement, not an option.
- **Redis-backed allocation.** Adds a second stateful service and a cross-store atomicity problem to a system whose entire durability story is one Postgres database.

## Consequences

- Recycling and collision-freedom reduce to one predicate that appears identically in the partial index and the lowest-free query — the invariant is enforced where the data lives, not where the code hopes.
- Restart survival for handles costs nothing: there is no state to rebuild because there is no state outside the database.
- A bug in allocation logic produces a rejected insert (unique violation), never a silent collision — the failure mode is loud by construction.
- Each submit pays a short transaction holding a per-`(user, lane)` advisory lock. Contention scope is one user's one lane; submits across users and lanes never serialize against each other.
