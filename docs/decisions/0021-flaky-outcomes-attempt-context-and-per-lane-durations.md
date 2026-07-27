# 0021. Flaky mock outcomes, an attempt-aware worker context, and per-lane duration defaults

Status: Accepted — 2026-07-26

## Context

Two lanes and three outcome params were enough to prove the engine. They are not enough to *show* it. Driving the finished dashboard surfaces three gaps at once.

The first is that nothing in the system can demonstrate a job that recovers. `params.fail` fails on every attempt, so a retryable failure always walks the whole budget and lands in `failed`; `params.fail_permanent` never retries at all. The `retrying` event, the backoff wake-up, and the attempt counter on the task object are all real and all exercised by the criteria suite — but a reviewer watching the register can only ever see them end badly. The one shape the mock worker cannot express is the ordinary one: a job that fails once, backs off, and succeeds. That shape is also the honest justification for the whole retry mechanism existing.

The second is a hard limitation underneath the first. To fail while the attempt number is below some threshold, a worker has to know its attempt number, and `WorkerContext` is `{ signal }`. The engine already computes the number — the claim's `UPDATE … attempts = attempts + 1 … RETURNING *` produces it, and it is written straight onto the `running` transition's `meta.attempt` — but it stops at the engine boundary and never reaches the function it describes.

The third is about time. Every registered lane draws an omitted `params.duration_ms` from 3000–15000 ms, so every job in a demo finishes inside fifteen seconds. That is a good default and a bad demonstration: it leaves no comfortable window in which to open a task, watch it run, cancel it mid-flight, or see the concurrency limit hold a queue back. A reviewer needs at least one lane whose jobs are still running a minute from now. And once a lane's range differs from the others, the submit form can no longer print "3–15 s" as a constant — [frontend-brief.md](../frontend-brief.md) §6.5 bars the UI from stating a number it cannot source from the server, and no response carries that number today.

## Decision

Three additive changes, one per gap.

**`params.fail_times`, an integer 1–9.** The mock worker returns a *retryable* failure while the current attempt number is ≤ `fail_times`, and succeeds on every attempt after it. Precedence is fixed and documented: `fail_permanent` wins over `fail`, which wins over `fail_times`. The reason text names the mechanism and the specific attempt — `"mock flaky failure: attempt 2 of 2 scheduled to fail via params.fail_times"` — so a reader of the history endpoint can tell a simulated flake from a real one without consulting the source. Validation lives with the other three params in `normalizeMockParams`, so a bad value is a `400 invalid_params` at submit and never a surprise at run time.

Crucially, this does **not** make the default outcome random. A submit carrying only `duration_ms` still succeeds, deterministically, exactly as before. Randomising outcomes server-side would make every criteria test a coin flip and would hide real failures inside expected ones; where the dashboard wants variety it rolls the dice itself and submits explicit params.

**`WorkerContext` gains `attempt` and `maxAttempts`.** Both come from the values the claim already computed — the same row, the same numbers the engine journals onto that claim's `running` transition — so what a worker is told and what the history endpoint reports agree by construction rather than by coincidence. A spec-shaped one-argument worker remains assignable and fully functional, which is the same test [ADR 0010](./0010-additive-api-extension-policy.md) applied to `ctx.signal`; this record extends that decision rather than reopening it.

**Five lanes, and `build` is the long one.** The registry becomes `scrape`, `report`, `convert`, `build`, `test`, in that order — which is contract, because it is the order `counts.lanes` reports and therefore the order the sidebar and submit picker render. `build` draws an omitted `duration_ms` from 20000–90000 ms; every other lane keeps the spec's 3000–15000. The *mechanism* is untouched from [ADR 0017](./0017-mock-params-normalized-by-caller.md): the value is still resolved once, at submit time, by the API, and written into the stored params, so retries reuse it and the task object shows what will actually happen. Only the range is per-lane. It is expressed as an optional argument to `normalizeMockParams` and a lane → range map in the API's registry, so engine-core still contains no lane names and no durations; the mock-worker module holds the two range constants because they are mock-worker facts.

**`counts.lane_defaults` — [EXTENSION], added by the API.** One entry per mock-worker-backed lane, in registration order, each carrying that lane's `duration_ms` `{ min, max }`. It is assembled in `routes/tasks.ts` when the counts object is serialised; `engine.counts()` and `TaskCounts` are untouched. That placement is the point, not an implementation detail: the ranges are mock-worker metadata, and the engine is the one component that must not know what `duration_ms` means.

## Alternatives considered

- **`fail_rate: 0.3` — a probabilistic flake.** Closer to a real flaky job, and untestable. A probabilistic outcome makes every assertion about it statistical, and a supplemental suite that fails one run in twenty is worse than no suite. `fail_times` is the same demonstration with a deterministic journal.
- **Make the outcome random when no outcome param is given.** Tempting, because it would populate a demo register with a realistic mix for free. Rejected outright: it would put a coin flip inside the criteria suite's own submits, and "the default job sometimes fails" is a property no reviewer should have to discover. Variety is a client-side dice roll producing explicit params — visible in the stored params, reproducible on retry.
- **Give the worker the whole task row instead of two numbers.** More general and much wider: `Job` is a spec-fixed shape, and widening the context to carry storage-shaped data invites workers to reason about state they must never own (architecture §8 — "workers never own state"). Two scalars answer the actual question.
- **Read the attempt number out of `job.params`.** No engine change at all, and a lie: params are client-supplied and immutable across retries, so any attempt number in them would be a number the client made up.
- **Put the per-lane range in the engine's lane registry (`LaneConfig`).** Superficially tidier — one registry instead of two lookups — but it teaches `createEngine` about `duration_ms`, which is exactly the coupling ADR 0017 was written to prevent. The lane → range map belongs with the lane → worker map, and both belong to the caller.
- **Let the SPA hard-code the ranges.** Zero server work, and a duplicated constant that goes stale the first time a lane is added or retuned. It is also precisely the invented number frontend-brief §6.5 forbids: the client would be *asserting* a server behaviour it cannot observe.
- **A separate `GET /lanes` metadata route.** A cleaner home in the abstract, but it adds a route under a spec-adjacent namespace, a second round trip before the submit form can render, and a second thing that can be out of date with respect to `counts.lanes`. Riding on the object that already reports the lane list keeps the two impossible to desynchronise.

## Consequences

- The task object, the five statuses, the four spec event shapes, and the six spec paths are all untouched. `fail_times` lives inside `params`, which the spec defines as free-form; `lane_defaults` is one additive key inside an already-additive object.
- Workers written against the spec's one-argument signature still compile and still run. Workers that want the new fields get them without opting in.
- `build` jobs outlive a short `DRAIN_TIMEOUT_MS`. That is the graceful-stop path working as designed — the drain window expires, the worker is aborted, and boot recovery re-queues the task (architecture §11) — but it does mean a deployment restart will visibly re-run in-flight builds. This is the at-least-once contract the system already advertises, now easy to actually observe.
- The seeded corpus was widened to all five lanes, with `build`'s seeded durations drawn from the long range, so seeded history teaches the same thing live behaviour does. A minority of the seeded `ready` tasks now carry a fail-then-succeed journal; that is a *shape* within an existing bucket, so architecture §12's normative 70/10/10/5/5 category split is unchanged.
- Two supplemental suites pin the new behaviour: `flaky-outcomes` (the recovery path end to end, the journal it produces, budget exhaustion, precedence, and the still-deterministic default) and `lane-registry` (registration order, `lane_defaults`, and each lane's omitted-duration range appearing in stored params).
