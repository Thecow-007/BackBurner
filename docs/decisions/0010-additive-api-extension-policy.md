# 0010. Additive API extension policy

Status: Accepted — 2026-07-21

## Context

The spec fixes six endpoints, a nine-field task object, four event shapes, and a five-value status enum — "field names and shapes are fixed." It also requires things that surface cannot express: a per-item state history view with timestamps, operator retry of failed jobs, and stable references once handles recycle.

## Decision

Fixed shapes are reproduced byte-for-byte; **every** divergence is additive and documented. Additions: task fields `id`, `attempts`, `max_attempts`, `seeded`; endpoints `POST /tasks/{handle}/retry`, `GET /tasks/id/{id}`, `GET /tasks/id/{id}/history`, and an unauthenticated `GET /health`; event types `running`, `retrying`, `collected` alongside the untouched spec four; `task_id` + `at` on all events; and a second worker-contract parameter, `WorkerContext { signal: AbortSignal }` (`Worker = (job, ctx) => Promise<WorkerResult>`) — a spec-shaped one-argument worker remains assignable, and the signal is required so a cancelled worker can actually stop, as the spec demands. Cancel itself is never extended — it stays legal from exactly `queued` and `running`, the spec's own words. The API reference carries a "Spec ambiguities & resolutions" table recording each interpretation call — including following the API contract's `lane` over the prose's "category," and the collect-from-failed interpretation that keeps cancel spec-pure ([ADR 0013](./0013-failed-tasks-are-collectable.md)).

## Alternatives considered

- **Strict spec-only surface.** The safest reading, but the dashboard's required state-history detail has no endpoint to call, and recycled handles leave events impossible to correlate. Strictness here means shipping known defects.
- **Free-form extension** — reshaping responses or renaming fields where "better" designs exist. Violates the contract's one explicit constraint and forfeits the trust the byte-for-byte discipline buys.
- **A versioned `/v2` surface for extensions.** Correct medicine for breaking changes; nothing here breaks. Two surfaces to document, test, and demo, serving zero clients that need the distinction.

## Consequences

- Compliance is mechanically checkable: diff any response or event against the spec's example and every spec-named field matches; extensions only ever add.
- Extension events use new type names, so a consumer written against the spec's four event types is never surprised by a changed shape — only by extra messages it can ignore.
- Cancel needs no extension and no rationale for one: it is byte-for-byte spec, full stop. The handle-release question for `failed` jobs is answered by interpretation, not by growing cancel's state set — see [ADR 0013](./0013-failed-tasks-are-collectable.md).
- Every resolved ambiguity is written down with its rationale, so a reviewer encountering a divergence finds a decision, not an accident.
