# 0017. Mock-worker param defaults are filled by the caller, not the engine core

Status: Accepted — 2026-07-23

## Context

When `duration_ms` is omitted on a mock-worker lane, [api-contract.md](../api-contract.md) §1 and [architecture.md](../architecture.md) §8 require that a random 3000–15000 ms value be chosen once, at submit time, and written into the stored params — so the task object echoes it and retries reuse it deterministically.

Architecture §8 *also* mandates that "the engine contains zero lane-specific logic." That property is what makes the engine a standalone, liftable module and lets new workers plug in without the core knowing their param shapes. But `duration_ms`/`fail`/`fail_permanent` are mock-worker concepts; teaching the engine's generic `submit()` to inspect and fill them would break it.

Separately, architecture §13 defines `DRAIN_TIMEOUT_MS`, yet the pinned engine surface (§2) exposed no parameter to carry it, and the engine never reads `process.env` itself.

## Decision

The engine exposes a pure helper, `normalizeMockParams(params, rng?)`, from its mock-worker module (not the core). The API calls it before `engine.submit()` for the lanes it wires to the mock worker (`scrape`, `report`). `submit()` stores whatever params it is handed, verbatim, and never rewrites params on any later transition — so a value the caller fills before submit is exactly as durable and retry-deterministic as one filled inside the engine would be.

Additively, `drainTimeoutMs?` is accepted on `EngineOptions` and `stop()` so the API can thread the env-read `DRAIN_TIMEOUT_MS` through. Existing call shapes (`createEngine({...})`, `stop({ drain: true })`) are unchanged.

## Alternatives considered

- **Fill `duration_ms` inside `engine.submit()`.** Matches the "at submit time" wording literally, but puts a specific worker's param semantics into the lane-agnostic core, contradicting §8's stronger architectural rule.
- **A per-lane param normalizer registered with the engine and run at submit.** More general, but still couples the core to worker param shapes and adds a mechanism the two bundled lanes don't need.

## Consequences

- The engine core stays free of any lane-specific knowledge; the mock worker's behavior lives entirely in its own module, exactly as a plugged-in worker should.
- Observable behavior is unchanged: the stored and echoed params include the filled duration, retries reuse it, and the mock result's `slept_ms` matches — the determinism the spec cares about is fully preserved.
- Filling the default is now a caller responsibility. The API does it; the Phase 4 seed module must also call `normalizeMockParams` before submitting, or a seeded task with an omitted duration won't carry one. A defensive fallback in the worker still picks a duration at execution time, so nothing breaks — it simply isn't echoed or retry-deterministic in that case.
