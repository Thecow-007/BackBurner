# 0004. One transitions table as history, outbox, and SSE replay log

Status: Accepted — 2026-07-21

## Context

Three requirements point at the same data. The dashboard's detail view must show each task's state history with timestamps. Lifecycle events must reach the SSE stream reliably — including across the crash window between a state change committing and its event being broadcast. And SSE clients that reconnect must be able to catch up on everything they missed. Solving these separately means three stores describing the same transitions.

## Decision

A single append-only `task_transitions` table serves all three roles. The row is inserted **in the same transaction** as the state-changing `UPDATE` on `tasks`, so a transition and its record are atomic. Its `bigint` identity column doubles as the SSE event id and replay cursor. Broadcast happens only after commit — the table is a transactional outbox. Reconnecting clients replay with `WHERE user_id = $1 AND id > $since ORDER BY id` (`user_id` is denormalized onto the row precisely for this scan); the subscribe path attaches the live listener first, replays, and dedupes by id so nothing falls in the gap.

## Alternatives considered

- **Separate outbox and history tables.** The textbook shape when the outbox is pruned aggressively and history has a different schema. Here every transition row would be written twice with identical content, and the SSE cursor would have to be reconciled across two id spaces.
- **In-memory ring buffer for replay.** Fast and simple — and empty at exactly the moment it matters, since clients reconnect en masse right after a restart wipes it.
- **`LISTEN/NOTIFY` as the delivery channel.** No replay for disconnected clients, an 8KB payload ceiling, and delivery is best-effort; it solves broadcast fan-out (not our bottleneck) while ignoring catch-up (our actual requirement).
- **Broadcast without transactional coupling.** Emit-then-write can announce a state that never commits; write-then-emit-outside-the-transaction can commit a state whose event is lost to a crash. Both crash windows are precisely what the outbox closes.

## Consequences

- An event exists if and only if its transition committed — phantom events and lost events are both structurally impossible, and a crash between commit and broadcast is covered by replay.
- Per-user catch-up is one monotonic integer over one index scan; the same integer is the SSE `id:`, the `?since=` parameter, and the browser's automatic `Last-Event-ID`.
- The history endpoint (`GET /tasks/id/{id}/history`) is a trivial indexed select over data that already had to exist.
- The table grows without bound. At this system's scale that is acceptable; pruning old transitions for collected tasks is documented as future work rather than built speculatively.
