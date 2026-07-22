# 0003. Event-driven push dispatch

Status: Accepted — 2026-07-21

## Context

The engine must start queued work the moment a concurrency slot opens — the success criteria expect a submitted job to show `running` within about a second. Work becomes startable at knowable moments: a job is submitted, a worker finishes, a cancellation frees a slot, a retry's backoff (`run_after`) elapses, or the process boots and recovers. A dispatcher can either be told about those moments or go looking for them on a clock.

## Decision

Dispatch is one idempotent, **single-flight** async function: an in-process mutex ensures one pass runs at a time, and a dirty flag re-runs it if anything fired mid-pass. It is invoked after every committed state change that could create work or free a slot, once at boot after recovery, and by a timer armed for the earliest future `run_after`. Each pass fills open slots by claiming the oldest eligible queued row with `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED) RETURNING *`, committing, broadcasting `running`, and starting the worker.

## Alternatives considered

- **Fixed-interval polling loop.** The simplest possible dispatcher, and a legitimate choice at this scale. But its latency floor is the polling interval, it issues queries forever on an idle system, and the interval itself is a tuning knob with no right value — too short wastes work, too long fails the "running within a second" expectation.
- **Postgres `LISTEN/NOTIFY`.** The right wake-up channel when *another process* needs to hear about changes. In a single-process engine it is a round trip through the database to reach a function we can call directly, notifications are not durable (a boot scan and a backoff timer are still required), and it pins a dedicated connection.
- **Per-job `setTimeout` scheduled at enqueue.** Appears simple, then accretes a scheduler: timers vanish on restart, backoff reschedules them, cancellation must hunt them down. This is re-implementing dispatch as distributed mutable state.

## Consequences

- Wake-up latency is a function call, not a poll interval; an idle engine issues zero queries.
- The dirty flag guarantees no lost wake-ups: any trigger arriving during a pass schedules exactly one follow-up pass.
- `FOR UPDATE SKIP LOCKED` is unnecessary for a single process and costs nothing — but it means a second engine process claiming from the same queue is a configuration change, not a redesign.
- All dispatch concurrency reasoning lives in one function; the rest of the engine just calls "kick" after commit and never thinks about slots.
- The timer for future `run_after` values is the one piece of clock-driven behavior, and it is re-armed from the database on boot, so backoff schedules survive restarts.
