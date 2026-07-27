# Test Plan

This document is the law for BackBurner's test suites. It is written to be executable before any
application code exists: every test below is specified precisely enough — names, setup, steps,
assertions, timing bounds — that the suites are authored first and the engine, API, and seed
tooling are then built to turn them green. The nine success criteria in the assessment spec
([docs/assessment-background-job-runner.pdf](./assessment-background-job-runner.pdf)) are the
backbone; everything else defends the contract around them.

---

## 1. Philosophy

**Criteria-first TDD.** The spec ships its own acceptance list: nine concrete checks, each written
as input plus expected observable outcome, which the reviewer will walk against the deployed app
and the test suite. Those nine checks are encoded as nine named tests — one file per criterion,
named after it — and committed *failing* before the first line of engine code. They are the
definition of done for the backend: when all nine are green against a real server and a real
PostgreSQL database, the core system works by the spec's own standard.

**Black-box over HTTP.** The criteria and supplemental e2e suites exercise the system exactly the
way the reviewer will: a real API server process, driven with `fetch` and an `EventSource` client,
asserting only on HTTP responses and the `/events` stream. The e2e package never imports engine
code. Direct SQL is permitted in setup and teardown only (create/truncate the test database, seed
test users); **assertions never read the database**. If a behavior cannot be observed over the API,
the test is asserting the wrong thing.

**Unit tests where black-box cannot be deterministic.** A small engine unit suite covers logic
whose edge cases are impractical to force over HTTP — lowest-free handle selection with arbitrary
gap patterns, backoff arithmetic, single-flight dispatch, serializer visibility rules. Everything
else earns its coverage at the boundary.

**No mocked time, no mocked transport in e2e.** Real process, real sockets, real Postgres, real
sleeps inside the mock worker. Determinism comes from event-driven waiting and env-tuned durations
(`BACKOFF_BASE_MS=100`), not from faking the clock.

---

## 2. Suite inventory

| Suite | Package | Files | Runs against |
|---|---|---|---|
| Criteria (spec §Success criteria, 1:1) | `packages/e2e` | `test/criteria/criterion-01…09.test.ts` | spawned API child process + test DB |
| Supplemental e2e | `packages/e2e` | `test/suites/*.test.ts` (14 files) | spawned API child process + test DB |
| Engine unit | `packages/engine` | `test/*.test.ts` | in-process; pure + DB-backed |

Vitest is the only runner. The e2e package runs with `fileParallelism: false` (one server + one
database at a time); engine unit tests may parallelize pure files but DB-backed files run serially.
The e2e package also sets `testTimeout: 120_000` and a matching `hookTimeout` — criteria 06 and 09
legitimately run ~37 s and ~55 s, which vitest's 5 s default would kill mid-flight; engine unit
suites keep the default. npm scripts map straight onto the inventory: `test:criteria` runs
`test/criteria/`, `test:supplemental` runs `test/suites/`, and `test:e2e` runs both — the CI jobs
in §7 split along exactly this mapping. `retry: 0` everywhere — see §9.

---

## 3. Harness design

All harness code lives in `packages/e2e/src/` and is shared by the criteria and supplemental
suites.

### 3.1 Server lifecycle

Each test (criteria suite) or test file (supplemental suites) spawns the real API server as a
**child process** via `spawnServer(envOverrides)`:

1. Spawn `node packages/api/dist/server.js` with `PORT=0` and the test environment (§3.4).
2. The server, once listening, prints exactly one machine-readable line to stdout:
   `BACKBURNER_READY {"port":<number>}`. This line is a contract on the API entrypoint: it is
   printed only after migrations have been verified, **boot recovery has completed**, and the
   socket is bound. "Migrations have been verified" means the server compares `schema_migrations`
   against the `migrations/` directory at boot — in every environment — and fails fast on any
   mismatch. In the harness this check always passes because `globalSetup` has already run the
   migration runner (§3.2); the production entrypoint additionally runs the runner itself before
   the check (architecture §12). The harness parses the port from the ready line; `PORT=0` makes
   port allocation race-free.
3. The harness confirms `GET /health` → `200 {"status":"ok"}` once, then hands the test a
   `{ proc, port, baseUrl, logPath }` handle.
4. Child stdout/stderr are piped to `packages/e2e/.logs/<test-name>.log` for post-mortem (uploaded
   as a CI artifact on failure).
5. Teardown: `stopServer(handle)` sends SIGTERM, waits up to `T_STOP` (§3.6) for exit — the
   graceful drain path — then falls back to SIGKILL; crash semantics are safe in teardown because
   every test starts from a truncated database. `killServer(handle)` uses `child.kill('SIGKILL')`
   — a hard kill on POSIX and `TerminateProcess` on Windows, which is exactly the crash semantics
   criterion 09 requires.

Startup must complete within `T_BOOT = 15_000 ms` or the harness fails the test with the log tail
attached.

```mermaid
sequenceDiagram
    participant T as Test (vitest)
    participant H as Harness
    participant S as API child process
    participant P as PostgreSQL (test DB)
    T->>H: spawnServer({WORKER_CONCURRENCY: 2})
    H->>P: TRUNCATE tasks, task_transitions; upsert test users
    H->>S: spawn node server.js (PORT=0, test env)
    S->>P: verify migrations, run boot recovery
    S-->>H: stdout: BACKBURNER_READY {"port":54321}
    H->>S: GET /health
    S-->>H: 200 {"status":"ok"}
    H-->>T: { baseUrl, proc }
    T->>S: fetch / EventSource (the test body)
    T->>H: stopServer() | killServer()
    H->>S: SIGTERM | SIGKILL
```

### 3.2 Test database lifecycle

- **One dedicated database per package**: `backburner_test_e2e` and `backburner_test_engine`,
  living on whatever server `E2E_DATABASE_URL` / `ENGINE_TEST_DATABASE_URL` point at (default:
  the dev compose Postgres at `localhost:5432`, user/password `postgres`). PostgreSQL 18 is
  required (`uuidv7()`).
- **Global setup** (vitest `globalSetup`): connect to the server's `postgres` maintenance DB,
  `CREATE DATABASE` if missing, run the repository migration runner (`node scripts/migrate.mjs`)
  against the test DB, then **truncate it**. Idempotent; safe on every run.
  The truncation is not redundant with the per-test reset below, and it is a §9 rule 1 fix rather
  than tidiness. Criteria files truncate *before* spawning their server; supplemental files spawn
  one server per file in `beforeAll` and truncate only in `beforeEach` — so the first supplemental
  server of a run boots against whatever the *previous* run left behind (`npm run test:criteria`
  reliably ends with one `running` row). Boot recovery correctly re-queues that row and the
  dispatcher claims it, so a worker slot is held by a task whose row the next `beforeEach` then
  truncates away; at `WORKER_CONCURRENCY=1` the file's first real job waits seconds for a phantom,
  and the new server's log shows nothing at all. Every run therefore starts from an empty database.
- **Per-test reset** (`beforeEach`): `TRUNCATE task_transitions, tasks RESTART IDENTITY CASCADE;`
  then upsert the two test users (§3.3). Truncation runs only while no server owns in-flight jobs:
  the criteria suite spawns a fresh server per test *after* truncation; supplemental suites keep
  one server per file and call the harness `settle()` helper before each truncation. `settle()`
  cancels every task in `queued` or `running` through the API — the only two states holding
  claimable work or a live worker, so pool idleness needs nothing else; `ready`- and
  `failed`-uncollected tasks hold no worker, and cancel on either is a `409` by the §5.2 matrix.
  Any `409` is treated as a benign completion race (the task reached a terminal state between
  listing and cancel), and `settle()` waits for the corresponding `cancelled` events only for the
  calls that returned `200`. The worker pool is therefore provably idle before the tables are
  cleared — finished-but-uncollected tasks (`ready` or `failed`) are left exactly as they are and
  cleared by the truncation itself, not by collection; `settle()` has no need to collect anything.
- Assertions never touch the DB; the two statements above are the entire SQL surface of the e2e
  package.

### 3.3 Test users and auth

Two users are upserted directly (setup SQL, allowed) with fixed, valid-format keys:

| User | Raw API key | Purpose |
|---|---|---|
| `e2e-alice` | `bb_` + `a1` ×20 (40 hex chars) | default actor for every test |
| `e2e-bob` | `bb_` + `b2` ×20 | cross-user isolation checks |

The stored value is `sha256(raw key)` as hex, matching the API's key scheme. All requests send
`Authorization: Bearer <key>`; `/events` uses `?api_key=<key>` — the same mechanism a browser
`EventSource` must use, so the tests exercise the reviewer-visible path.

### 3.4 Environment knobs

Every test-relevant behavior is env-tunable. Baseline test environment for every spawned server:

| Variable | Test baseline | Why |
|---|---|---|
| `DATABASE_URL` | `…/backburner_test_e2e` | isolation from dev data |
| `PORT` | `0` | race-free random port |
| `WORKER_CONCURRENCY` | `4` (overridden to `2` where a test says so) | criteria 6, 7, 9 pin concurrency |
| `BACKOFF_BASE_MS` | `100` | retry chains complete in ~1 s instead of ~14 s |
| `DRAIN_TIMEOUT_MS` | `1000` | keeps the SIGTERM drain path bounded in teardown (default `30000` — architecture §12) |
| `SSE_HEARTBEAT_MS` | `20000` (lowered only in the heartbeat test) | default behavior under test |
| `NODE_ENV` | `test` | no prod entrypoint side effects |

### 3.5 Event client and wait helpers

The stream is consumed with the `eventsource` npm package (query-param auth, identical to the
browser client). A raw `fetch` body reader is used only where `EventSource` is structurally blind:
observing `: hb` heartbeat comments and sending an explicit `Last-Event-ID` request header.

The harness wraps the client in an `EventCapture`:

- Buffers every event as `{ id, type, handle, lane, task_id, at, ...rest }` (parsed `data:` JSON
  plus the SSE `id:` field). All events carry `task_id` — assertions correlate by `task_id`, never
  by bare handle, because handles recycle.
- `waitFor(predicate, timeoutMs, label)` — resolves with the first matching event; on timeout,
  rejects with the label, the full buffered event list, and the server log tail.
- `waitForCount(predicate, n, timeoutMs)` — n distinct matches.
- `assertNever(predicate, { sentinel, settleMs })` — collects until the *sentinel* event arrives,
  then `settleMs` longer, and fails if the forbidden predicate ever matched. Negative assertions
  are only valid in this form (§3.6, rule 3).
- `all()` — snapshot of the buffer for ordering/timeline assertions.

### 3.6 Timing discipline

Constants live in one file, `packages/e2e/src/timing.ts`:

| Constant | Value | Meaning |
|---|---|---|
| `T_BOOT` | 15 000 ms | spawn → ready line |
| `T_HTTP` | 1 000 ms | spec's "well under one second" enqueue bound (criterion 1; a **spec law**, not a tunable) |
| `T_EVENT` | 2 500 ms | any promptly-caused event (accepted, running after a free slot, cancelled) |
| `T_JOB(d)` | `d + 5 000 ms` | ready/failed after a job of duration `d` starts |
| `T_SETTLE` | 5 000 ms | tail window after a sentinel in negative assertions |
| `T_STOP` | 3 000 ms | SIGTERM → SIGKILL fallback in `stopServer` (§3.1) |
| `T_RETRY_CHAIN` | 10 000 ms | a full 3-attempt failure chain lands in `failed` (§4.5) |
| `T_WAVES(n, d)` | `n·d + 10 000 ms` | completion bound for `n` dispatch waves of duration-`d` jobs (§4.7, §4.9) |

No criterion uses a bare timing literal — every bound in §4 appears here by name. Note on
`T_HTTP`: it is always measured against a warmed connection pool (§4.1's unmeasured warm-up
request) — the spec bound constrains request handling, not process cold-start.

Rules (binding on every test):

1. **Never sleep blind.** All waiting is `waitFor`/`waitForCount` with an explicit timeout. The
   only sleep in the harness is the sentinel-bounded `settleMs` tail inside `assertNever`.
2. **Upper bounds are generous, lower bounds are rare.** CI machines are slow; upper bounds assume
   the worst. The only tight lower bound is the spec's own: enqueue < 1 s. Lower bounds that prove
   work actually ran (e.g. "ready no earlier than ~duration") use a 10 % tolerance.
3. **Negative assertions require sentinels.** "Event X never arrived" is meaningless if the stream
   died. Every MUST-NOT assertion is bounded by a positive event that must arrive *after* the
   window in which X could have appeared (see criterion 06 for the pattern).
4. **Correlate by `task_id`.** Handles are recyclable aliases; timeline assertions filter the
   buffer by `task_id`.
5. **Never assert on randomized values exactly.** Default worker durations and backoff jitter are
   random by design; tests always pin `duration_ms` explicitly and assert jittered delays as
   ranges.

---

## 4. Criteria suite — the nine reviewer checks

One test file per criterion, `packages/e2e/test/criteria/`. Each test truncates the DB, spawns a
fresh server with the baseline env (§3.4) plus the overrides listed, and tears the server down in
`afterEach`. All actions are performed as `e2e-alice` unless stated. "ES" means an `EventCapture`
connected to `/events` *before* the first submit, so no event can be missed.

### 4.1 `criterion-01-instant-handle`

> **Spec:** "Instant handle. Submit a scrape job with `duration_ms: 10000`. The `POST /tasks`
> response returns `{ "handle": "scrape-1", "status": "queued" }` in well under one second, far
> less than the 10s the job will take. The handle is in hand long before the work is done."

**Setup:** default env. No stream needed — this criterion is pure HTTP latency.

**Steps**

1. Warm-up, unmeasured: one `GET /tasks`, response discarded. This exercises the DB path once —
   pool connection, route and schema compilation — so first-request costs never land inside the
   one timing assertion the flakiness policy forbids widening (§9).
2. `t0 = performance.now()`; `POST /tasks` `{ "lane": "scrape", "params": { "duration_ms": 10000 } }`;
   `t1 = performance.now()`.
3. `GET /tasks/scrape-1`.

**Assertions**

- Response status `201`; `t1 − t0 < 1000 ms` (`T_HTTP` — spec bound, never widened).
- Body: `handle === "scrape-1"`, `status === "queued"`, `lane === "scrape"`, `result === null`,
  `error === null`, `collected === false`, `created_at`/`updated_at` are ISO-8601 UTC strings —
  all nine spec fields present with spec shapes.
- Step 3 returns the same task with `status` ∈ {`queued`, `running`} — the job is demonstrably
  not finished when the handle is already in hand.

### 4.2 `criterion-02-lifecycle-to-ready`

> **Spec:** "Lifecycle to ready. For that same `scrape-1`: it shows `running` within about a
> second, then `ready` after about 10s. `GET /tasks/scrape-1/result` returns the result and flips
> `collected` to true. The `/events` stream carried an `accepted` then a `ready` event for
> `scrape-1`."

**Setup:** default env; ES connected.

**Steps**

1. Submit scrape, `duration_ms: 10000`. Record `task_id` from the `201` body.
2. `waitFor(accepted for task_id, T_EVENT)`.
3. `waitFor(running for task_id, T_EVENT)`; record arrival time `tRun`. `GET /tasks/scrape-1` →
   `status === "running"`.
4. `waitFor(ready for task_id, T_JOB(10000))`; record `tReady`.
5. `GET /tasks/scrape-1/result`.

**Assertions**

- Event order by SSE id: `accepted.id < running.id < ready.id`; `accepted` and `ready` carry the
  spec shape (`type`, `handle: "scrape-1"`, `lane: "scrape"`, `summary` string).
- `tReady − tRun ≥ 9 000 ms` (the 10 s of work actually happened) and ≤ `T_JOB(10000)`.
- Step 5: `200`, full task object: `status === "ready"`, `collected === true`, `result` non-null
  containing `message` (string) and `slept_ms` (number); `error === null`.
- MUST NOT arrive (whole test, checked against the final buffer): any `failed` or `cancelled`
  event for `task_id`.

### 4.3 `criterion-03-per-lane-numbering`

> **Spec:** "Per-category numbering. Submit one `scrape` and one `report` job. They get `scrape-1`
> and `report-1`, not `scrape-1` and `scrape-2`. Submit a second `scrape` while the first still
> runs: it gets `scrape-2`."

**Setup:** default env.

**Steps**

1. Submit scrape, `duration_ms: 10000` → expect handle `scrape-1`.
2. Submit report, `duration_ms: 10000` → expect handle `report-1`.
3. Immediately (first scrape has ≈10 s left) submit a second scrape → expect handle `scrape-2`.
4. `GET /tasks`.

**Assertions**

- The three `201` bodies carry exactly `scrape-1`, `report-1`, `scrape-2`.
- Step 4 lists exactly three tasks; handles and lanes match; the two scrape tasks have distinct
  `task_id`s.

### 4.4 `criterion-04-recycling-no-collision`

> **Spec:** "Recycling without collision. Run `scrape-1` to completion and collect it, then submit
> a new scrape job: it may reuse `scrape-1`. But while a `scrape-1` is still queued, running, or
> finished-but-uncollected, a newly submitted scrape job must be `scrape-2`. A handle is never
> reused while its previous owner is still active."

**Setup:** default env; ES connected.

**Steps**

1. Submit scrape A, `duration_ms: 1000` → `scrape-1`. `waitFor(ready for A, T_JOB(1000))`.
2. A is now ready-but-uncollected. Submit scrape B, `duration_ms: 10000`.
3. `GET /tasks/scrape-1/result` → collect A.
4. Submit scrape C, `duration_ms: 10000`.
5. `GET /tasks/scrape-1`.

**Assertions**

- Step 2: B's handle **must** be `scrape-2` — finished-but-uncollected A still holds `scrape-1`.
- Step 3: `200`, `collected === true`.
- Step 4: C's handle **must** be `scrape-1`. (The spec says a new job *may* reuse it; BackBurner's
  allocator guarantees lowest-free, so the assertion is deterministic and stricter than the spec
  requires.) `C.task_id ≠ A.task_id` — a recycled handle is a new task under a reused alias.
- Step 5 resolves to C (the active holder), not A: returned task `status ∈ {queued, running}` and
  id equals `C.task_id`.

### 4.5 `criterion-05-failure-surfaces`

> **Spec:** "Failure surfaces, no auto-collect. Submit a job with `fail: true`. It lands in
> `failed` with `error.retryable` set and a reason; the `/events` stream carried a `failed` event;
> the job is not silently collected; the operator can retry it."

**Setup:** default env (`BACKOFF_BASE_MS=100` makes the full 3-attempt retry chain take ≈1.5 s);
ES connected.

**Steps**

1. Submit scrape `{ "duration_ms": 300, "fail": true }` (default `max_attempts` = 3) → `scrape-1`,
   record `task_id`.
2. `waitFor(failed for task_id, T_RETRY_CHAIN)`.
3. `GET /tasks/scrape-1`.
4. `POST /tasks/scrape-1/retry`.
5. `waitFor(running for task_id, T_EVENT)`.

**Assertions**

- The `failed` event has the spec shape: `type`, `handle`, `lane`, `reason` (the worker's honest
  string `"mock failure requested via params.fail"`, not a generic "failed"), `retryable: true`.
- Exactly two `retrying` events for `task_id` preceded it (attempts 1 and 2 were auto-retried with
  backoff; the third exhausted the budget — asserts the documented auto-retry extension events).
- Step 3 (not silently collected): `status === "failed"`, `error === { reason, retryable: true }`,
  `attempts === 3`, `collected === false`, `result === null` — the failure has fully surfaced, and
  `collected` is still `false` because collection never happens on its own; only an explicit
  `GET /tasks/scrape-1/result` call would flip it (exercised in full by [§5.8](#58-collect-semantics)).
- Step 4 (operator can retry, while still uncollected): `200`, `status === "queued"`,
  `attempts === 0` (fresh budget).
- Step 5: a `running` event arrives ≤ `T_EVENT` — the retried job was genuinely re-dispatched.
- MUST NOT arrive at any point before step 4: any `ready`, `cancelled`, or `collected` event for
  `task_id`.

### 4.6 `criterion-06-cancel-running-and-queued`

> **Spec:** "Cancellation, running and queued. Submit a job with `duration_ms: 30000` and cancel
> it mid-run: it moves to `cancelled`, no later `ready` event arrives for it (the worker actually
> stopped), and `/events` carried a `cancelled` event. Repeat for a job still sitting in the queue
> behind the concurrency limit: same result."

**Setup:** `WORKER_CONCURRENCY=2`; ES connected. Three jobs, all `duration_ms: 30000`:
**A** is the sentinel that runs to completion, **B** is cancelled mid-run, **C** is cancelled
while queued.

**Steps**

1. Submit A, then B. `waitForCount(running, 2, T_EVENT)` — both slots occupied.
2. Submit C. `GET /tasks/scrape-3` → `status === "queued"` (behind the concurrency limit).
3. Cancel queued C: `POST /tasks/scrape-3/cancel` → `200`, `status === "cancelled"`.
   `waitFor(cancelled for C, T_EVENT)`.
4. Cancel running B (mid-run, ~2 s into its 30 s): `POST /tasks/scrape-2/cancel` → `200`,
   `status === "cancelled"`. `waitFor(cancelled for B, T_EVENT)`.
5. Slot-release probe: immediately after B's `cancelled` event, submit probe job D
   (`duration_ms: 30000`) and `waitFor(running for D, T_EVENT)`.
6. `waitFor(ready for A, T_JOB(30000))` — the sentinel. Keep capturing for `T_SETTLE` more.
7. Final `GET /tasks`: A `ready`, B `cancelled`, C `cancelled`, D `running` or `ready`.

**Assertions**

- Both `cancelled` events carry the spec shape `{ type, handle, lane }`.
- A's `ready` event arrives ≈30 s after its `running` event (≥ 27 000 ms) — this sentinel proves
  the worker pool and the stream stayed healthy through the entire window in which B (cancelled at
  ~2 s, original completion ~30 s) and C (would have been claimed when B's slot freed, completing
  ~32 s) would have finished had cancellation not truly stopped them.
- D's `running` event arrives within `T_EVENT` of B's `cancelled`. With `WORKER_CONCURRENCY=2`
  and A occupying one slot, D can only start promptly if B's worker genuinely stopped and released
  its slot: an engine that never aborts and lets B run silently holds the slot ~28 s longer, and
  this wait times out. The ghost-`ready` MUST-NOT below cannot catch that engine on its own,
  because the documented stale-completion discard (api-contract §6.5) suppresses the ghost event
  — the probe closes the gap.
- MUST NOT arrive, from submit until `A.ready + T_SETTLE` (`assertNever` with A's `ready` as
  sentinel): any `ready` or `failed` event for B or C; any `running` event for C. B finishing
  silently or C ever starting is a hard failure — this is the "worker actually stopped" check.
  The predicate is scoped to B and C; D's eventual `ready` is exempt.

### 4.7 `criterion-07-concurrency-limit`

> **Spec:** "Concurrency respected. With concurrency set to 2, submit 5 jobs at once. At no moment
> are more than 2 in `running`; the rest stay `queued` and start only as slots free up."

**Setup:** `WORKER_CONCURRENCY=2`; ES connected.

**Steps**

1. Submit 5 scrape jobs, `duration_ms: 2000` each, concurrently (`Promise.all`).
2. `waitForCount(ready, 5, T_WAVES(3, 2000))` (3 waves × 2 s plus overhead), then capture
   `T_SETTLE` more.
3. Reconstruct the running-count timeline: sort all events for these 5 `task_id`s by SSE id;
   `running` ⇒ +1, `ready`/`failed`/`cancelled` ⇒ −1; compute the running count after every
   prefix.

**Assertions**

- All five `201`s returned `status: "queued"`, and the *set* of handles across the five bodies is
  exactly `{scrape-1 … scrape-5}` — set equality, with no positional mapping to `Promise.all`
  order. The advisory lock serializes allocation in server arrival order, which need not match the
  client's array order; §5.3 phrases its burst assertions the same way.
- The prefix-sum timeline never exceeds **2** at any point.
- Exactly 5 `running` and 5 `ready` events; zero `failed`/`cancelled`.
- The 3rd `running` event has a larger SSE id than the 1st `ready` event — slots are granted only
  as they free up, never eagerly.
- Final `GET /tasks`: all 5 `ready`.

### 4.8 `criterion-08-concurrent-completions`

> **Spec:** "Concurrent completions. Submit 3 jobs that all finish within about a second of each
> other. All 3 reach `ready`, all 3 `ready` events arrive on the stream, and no state is lost,
> duplicated, or left stuck in `running`."

**Setup:** `WORKER_CONCURRENCY=4` (all three run simultaneously); ES connected.

**Steps**

1. Submit 3 scrape jobs, `duration_ms: 3000` each, concurrently — identical durations and
   simultaneous starts make them complete within ~1 s of each other.
2. `waitForCount(ready, 3, T_JOB(3000))`; keep capturing for `T_SETTLE`.
3. `GET /tasks`.

**Assertions**

- Premise check: the three `ready` arrival times span < 2 000 ms (the scenario the spec describes
  was actually exercised).
- Exactly 3 `ready` events with 3 distinct `task_id`s — **no duplicates**: no `task_id` appears in
  more than one `ready` event, including during the settle window.
- Each `ready` event's SSE id is unique and strictly increasing in arrival order.
- Step 3: all 3 tasks `status === "ready"`; zero tasks `running` or `queued` — nothing lost,
  nothing stuck.
- MUST NOT arrive: any `failed` or `cancelled` event.

### 4.9 `criterion-09-restart-durability`

> **Spec:** "Durability across restart. Submit several jobs so some are running and some queued,
> kill the backend process, and restart it. `GET /tasks` still shows every job with its correct
> status; in-flight work is resumed or cleanly re-queued; nothing is lost. This and the
> no-collision check are the two we verify most carefully."

**Setup:** `WORKER_CONCURRENCY=2`; ES connected to server #1.

**Steps**

1. Submit 5 scrape jobs A–E, `duration_ms: 8000` each. `waitForCount(running, 2, T_EVENT)` —
   two jobs in flight, three queued.
2. Pre-kill snapshot: `GET /tasks` — record every `task_id`, handle, status, and the response's
   `as_of` cursor. Expect exactly 2 `running`, 3 `queued`. The two tasks recorded as `running`
   are the **interrupted pair** — identified by snapshot status, never by submission order.
3. **`killServer` (SIGKILL / `TerminateProcess`)** — no drain, no goodbye. Await process exit;
   close the ES connection.
4. Spawn server #2 against the same `DATABASE_URL` (new random port). The ready line implies boot
   recovery has completed (§3.1).
5. Immediately `GET /tasks` on server #2.
6. Connect a new ES to server #2 with `?since=<as_of from step 2>`.
7. `waitForCount(ready, 5, T_WAVES(3, 8000))` (recovery + 3 waves × 8 s); the 5th `ready` is the
   sentinel — keep capturing for `T_SETTLE` more, as criterion 08 does. Final `GET /tasks`.

**Assertions**

- Step 5: exactly 5 tasks — same `task_id`s and same handles as the pre-kill snapshot; **nothing
  lost, nothing invented**. Every status ∈ {`queued`, `running`}: the interrupted pair was
  cleanly re-queued (or already re-claimed), never silently `ready`, `failed`, or `cancelled`.
  The interrupted pair's attempt count is status-conditional: `attempts === 1` while `queued`,
  `attempts === 2` once `running` — the ready line implies recovery's final `dispatch()` has
  already run (§3.1), so re-claiming may have happened, and a re-claim increments `attempts` at
  claim time.
- Step 6 replay: the recovery `retrying` events for the interrupted pair arrive with the
  top-level field `recovery: true`, plus `attempt`/`max_attempts` (api-contract §8) — the durable
  event log survived the crash and the `as_of` cursor from before the kill is a valid resume
  point. SSE frames have no `meta` wrapper; `meta.*` assertions belong only to
  `GET /tasks/id/{id}/history`, as §5.4 does.
- Step 7: 5 `ready` events with 5 distinct `task_id`s, no duplicates; final statuses all `ready`;
  the interrupted pair finish with `attempts === 2`, the other three with `attempts === 1` — the
  deterministic budget check lives here, after completion, not in step 5.
- MUST NOT arrive on the server #2 stream, evaluated per §3.6 rule 3 with the 5th `ready` as
  sentinel plus the `T_SETTLE` tail: any `failed` or `cancelled` event, or a second `ready` for
  any `task_id` — judged against the final buffer.

---

## 5. Supplemental e2e suites

Same harness, one server per file (baseline env unless noted), `settle()` + truncate between
tests. These defend the full API contract around the criteria.

### 5.1 `auth-isolation`

| Case | Expect |
|---|---|
| No `Authorization` header on any `/tasks*` route | `401` envelope, code `unauthorized` |
| Malformed header (`Basic …`, empty `Bearer`) | `401` |
| Well-formed but unknown key (`bb_` + 40 zeros) | `401` |
| `/events` with missing or wrong `?api_key=` | `401` |
| `?api_key=` on `GET /tasks` (no header) | `401` — no endpoint other than `/events` accepts query-param auth |
| `/events` with a malformed `Authorization` header plus a valid `?api_key=` | `401` — when both are supplied, the header wins (api-contract §2) |
| `GET /health` with no auth | `200 {"status":"ok"}` |
| Alice submits `scrape-1`; Bob `GET /tasks` | `200`, empty list — no leakage |
| Bob `GET /tasks/scrape-1` / `…/result` / `cancel` / `retry` on Alice's task | `404` — handle namespaces are per-user; Bob's `scrape-1` simply does not exist |
| Bob's `/events` stream while Alice's job runs to completion | MUST NOT carry any of Alice's events; sentinel: Bob submits his own job and sees his own `accepted` (and later `ready`) arrive |

### 5.2 `invalid-transition-matrix`

Drives one task into each state, then attempts every operator action. State factories: *queued* —
submit behind a saturated pool (`WORKER_CONCURRENCY=1` for this file plus one long blocker);
*running* — submit and wait for `running`; *ready* (uncollected) — 500 ms job, wait `ready`;
*ready* (collected) — the same, plus `GET …/result` once; *failed* (uncollected) —
`{ fail: true, max_attempts: 1 }` (fast, single attempt); *failed* (collected) — the same, plus
`GET …/result` once; *cancelled* — submit queued, cancel.

| From ↓ / Action → | `cancel` | `retry` | `collect` (`GET …/result`) |
|---|---|---|---|
| `queued` | `200` → cancelled | `409` | `409` |
| `running` | `200` → cancelled | `409` | `409` |
| `ready` (uncollected) | `409` | `409` | `200` → collected |
| `ready` (collected) | `409` | `409` | `200` idempotent (see 5.8) |
| `failed` (uncollected) | `409` | `200` → queued | `200` → collected |
| `failed` (collected) | `409` | `409` | `200` idempotent (see 5.8) |
| `cancelled` | `409` | `409` | `409` |

Every `409` body is asserted in full: `{ error: { code: "invalid_state", message, current_status:
"<actual>" } }`. Every `200` is followed by a wait for the corresponding event (`cancelled`,
`running` after retry, `collected`) so the matrix also verifies the event side of each legal move.
The `failed` (collected) row exercises the case added by this table's new `retry` column: a
retry attempt on a failed-but-already-collected task is `409` — collection permanently retires
the retry option (state factory: drive to `failed`, then `GET …/result` once to collect it before
attempting retry).

### 5.3 `allocator-race`

`WORKER_CONCURRENCY=2` so most tasks stay active (queued) throughout.

1. **Single-lane burst:** 20 concurrent `POST /tasks` (`scrape`, `duration_ms: 15000`). All 20
   return `201`; the handle set is exactly `{scrape-1 … scrape-20}` — no duplicates, no gaps.
2. **Cross-lane burst:** 10 `scrape` + 10 `report` concurrently → each lane numbered `1…10`
   independently.
3. **Race into freed numbers:** cancel 5 of the 20 (numbers 3, 7, 8, 15, 20), await the 5
   `cancelled` events, then submit 5 new scrape jobs concurrently → their handles are exactly the
   5 freed numbers (lowest-free, collision-free under concurrency).

### 5.4 `handle-resolution`

1. Run `scrape-1` to `ready`, collect it. `GET /tasks/scrape-1` → still `200`, returns the
   collected task (most recent former holder) — a reviewer can inspect a task right after
   collecting it.
2. Submit a new scrape (reuses `scrape-1`). `GET /tasks/scrape-1` now returns the **active**
   holder; the old task remains reachable at `GET /tasks/id/{id}` (extension endpoint — stable
   identity across recycling).
3. `GET /tasks/id/{id}/history` for the completed first task → `200`,
   `transitions` ordered by time: `accepted → running → ready → collected`, each with
   `from_status`/`to_status`/`at`.
4. Failed tasks hold their handle — the load-bearing "active includes finished-but-uncollected
   `failed`" rule, end-to-end: drive `scrape-1` to `failed` (`fail: true`, `max_attempts: 1`).
   Submit a new scrape → its handle is `scrape-2`. Collect the failed `scrape-1` via
   `GET /tasks/scrape-1/result` → `200`, full task object, `collected: true`, `error` populated,
   and a `collected` event on the stream; the handle is now freed. Submit again → the new task
   reuses `scrape-1`.
5. Never-allocated handle (`scrape-99`), unknown-lane handle (`nosuch-1`), malformed handle
   (`scrape`, `scrape-0`, `scrape--1`) → `404`, code `not_found`.

### 5.5 `sse-replay`

1. Produce a known history: 3 jobs to terminal states while a live ES records every event id.
2. `?since=0` → the full per-user history replays, ids strictly increasing, no gaps or dupes.
3. `?since=<mid-stream id>` → exactly the events with `id > since`, in order.
4. Raw `fetch` with header `Last-Event-ID: <mid>` → same result as `?since=<mid>`; when both are
   present the header wins (it reflects reconnect state, which is fresher than the original URL).
5. `?since=abc` → `400 invalid_params`, enveloped (api-contract §6.9) — a malformed cursor is
   rejected at connect time, never silently ignored.
6. **Gap-free hydration:** `GET /tasks` → take `as_of`; immediately trigger a new submit; connect
   `?since=<as_of>` → the new task's `accepted` (and all subsequent events) arrive; nothing falls
   in the crack between snapshot and stream.
7. **Replay + live seam:** connect with `?since=0` while a job is mid-flight → replayed and live
   events arrive deduplicated by id, still strictly increasing.
8. **Heartbeat:** server spawned with `SSE_HEARTBEAT_MS=250`; a raw reader sees ≥ 2 `: hb` comment
   lines within 2 s; the EventSource connection stays open throughout.

### 5.6 `filters-pagination`

Corpus per test file: ~12 tasks across both lanes driven into `queued` (behind blockers), `ready`,
`ready+collected`, `failed`, `cancelled` via the API.

- `?status=` for each of the five values → only matching tasks; `?lane=` likewise; combined
  `?status=&lane=` intersects.
- `?from=`/`?to=` on `created_at`: `from` = one hour ago → all; `to` = one hour ago → none; a
  bracketing pair → all.
- `?sort=created_at:asc|desc` (default `created_at:desc`), `?sort=updated_at:desc` — acting on an
  old task (retry) moves it to the front; invalid sort key → `400`.
- `?limit=5` → 5 rows + non-null `next_cursor`; walking the cursor chain yields every task exactly
  once, pages disjoint, order stable; final page has `next_cursor: null`; `?limit=201` → `400`.
- `as_of` present on every list response and ≥ the SSE id of the last event the test observed
  before the call.

### 5.7 `validation-400s`

Every case asserts the full envelope `{ error: { code, message } }`:

| Request | Code |
|---|---|
| `POST /tasks` `{ "lane": "nosuchlane" }` | `unknown_lane` |
| Missing `lane` | `invalid_params` |
| `params` is an array / string / number | `invalid_params` |
| `duration_ms`: `-1`, `0`, `1.5`, `"10000"`, `600001` | `invalid_params` (each) |
| `fail` / `fail_permanent`: `"yes"`, `1` | `invalid_params` (each) |
| `max_attempts`: `0`, `11`, `2.5` | `invalid_params` |
| Syntactically invalid JSON body | `invalid_params` — body-parse failures are mapped onto the envelope (api-contract §3) |
| Unknown top-level body field (`{"lane":"scrape","unknown":1}`) | `invalid_params` — the free-form area is `params`, nothing else |
| `GET /tasks/id/not-a-uuid` | `invalid_params` |
| Extra unknown params keys (`{"duration_ms":1000,"custom":"x"}`) | **`201`** — params pass through by design |

### 5.8 `collect-semantics`

Collection is the one GET with a side effect, so it gets its own suite beyond the 5.2 matrix rows:

1. Collect a `ready` task → `200` full task object, `collected: true`, `result` populated,
   `error === null`; exactly one `collected` event (extension) on the stream.
2. Collect a `failed` task → `200` full task object, `collected: true`, `error` populated,
   `result === null`; exactly one `collected` event on the stream. A follow-up
   `POST …/retry` on the same handle → `409` `invalid_state` with `current_status: "failed"` —
   collection has permanently retired the retry option.
3. Immediately `GET …/result` again on either collected task while the handle still resolves to
   the same task → `200`, same body, `collected` still `true`, and MUST NOT emit a second
   `collected` event (sentinel: a subsequent unrelated submit's `accepted`).
4. After the handle is reused by a new queued task, `GET …/result` on that handle → `409`
   `invalid_state` with `current_status: "queued"` — resolution favors the active holder.
5. Collect attempts on `queued`, `running`, `cancelled` tasks → `409`, `current_status` echoing
   the actual state (overlaps 5.2 deliberately). This, together with cases 1–2, is the spec's
   "not silently collected" guarantee from the collect side: collection succeeds on either
   terminal outcome, `ready` or `failed`, but never happens automatically — only an explicit
   `GET …/result` call ever flips `collected`.

### 5.9 `seeds-smoke`

Runs the real seed CLI as a child process against the test DB, then verifies through the API only:

1. `npm run seed -- --tasks 50 --from 2026-04-01 --to 2026-07-01` → exit 0; stdout contains one
   line per seeded user matching `/^(daniel|reviewer|newcomer): (bb_[0-9a-f]{40})$/` — the raw
   keys, printed once. All **three** lines must be present.
2. Using the parsed `reviewer` key: `GET /tasks?limit=200` → tasks exist; **every** task has
   `seeded: true`; statuses only from {`ready` (collected and uncollected), `failed` (collected
   and uncollected), `cancelled`} — **zero** seeded `queued` or `running` rows (a seeded in-flight
   job is a lie the recovery path would expose); every `created_at` within `[from, to]`. Presence,
   not just absence: at least one seeded task in each of `ready`+collected, `ready`+uncollected,
   `failed`+collected (older, acknowledged), `failed`+uncollected (recent, actionable), and
   `cancelled` — a seeder that produces a 100 %-collected corpus, or one whose failed cohort is
   never actionable, must fail this test. The target distribution is documented in
   architecture.md's seed-data section. Every registered lane appears in the seeded corpus, and
   every seeded `build` task's `duration_ms` is inside that lane's live 20000-90000 ms range — a
   seeded corpus that contradicted live behaviour would teach a reader the wrong thing.
2b. Using the parsed `newcomer` key: `GET /tasks?limit=200` → `200` with an **empty** task list,
   `counts.all === counts.matching === counts.uncollected === 0`, and the full registered-lane
   list still present. `newcomer` is provisioned with a working key and deliberately given zero
   tasks so every empty state can be demonstrated on demand (architecture.md §12).
3. Live-data coexistence: submit a real task in a seeded lane → `201`, handle allocation succeeds
   (seeded active tasks went through the real allocator, so no unique-index collision), and the
   new task has `seeded: false`.
4. `npm run seed -- --reset` → the real task from step 3 survives; all seeded tasks are gone; the
   `reviewer` and `newcomer` keys captured in step 1 are both still valid (reset ensures the seed
   users exist without rotating keys). Re-seeding after reset succeeds (idempotent lifecycle).

### 5.10 `non-retryable-failure`

The spec names two permanent-failure flavors. Criterion 05 proves repeated exhaustion; this suite
proves "a job marked non-retryable":

1. Submit scrape `{ "duration_ms": 300, "fail_permanent": true }` (default `max_attempts` 3) →
   `scrape-1`.
2. The task lands in `failed` after exactly one attempt: `attempts: 1`, `error.retryable === false`,
   reason `"mock permanent failure requested via params.fail_permanent"` — distinct from both the
   transient reason and a generic "failed", per the spec's distinct-honest-reasons requirement.
3. The stream carried `accepted → running → failed` with **zero `retrying` events** (assertNever on
   `retrying` from submit until `failed` + T_SETTLE): `retryable: false` short-circuits the attempt
   budget entirely.
4. Operator retry is still legal: `POST /tasks/scrape-1/retry` → `200`, re-queued with a fresh
   budget — "the operator decides when to retry" applies to permanent failures too; the
   `retryable` flag gates **auto**-retry only.
5. Precedence: `{ "fail": true, "fail_permanent": true }` → `fail_permanent` wins — straight to
   `failed`, `retryable: false`, no `retrying` events.

### 5.11 `counts-coherence`

The `counts` object on `GET /tasks` (api-contract §6.2, [ADR 0018](./decisions/0018-task-counts-on-list-response.md)), and the
`?uncollected=true` filter that opens one of its numbers ([ADR 0022](./decisions/0022-uncollected-and-search-list-filters.md)). The
rule under test is an honesty rule — **a count must always match the list it opens** — complicated
by the fact that the seven fields do not share one filter basis (`all` ignores `status`/`lane`;
`status.*` ignores `status`; `lane.*` ignores `lane`; `matching` respects everything; the
`uncollected` count ignores `status` *and the `uncollected` filter*, because it is that predicate;
`lanes` and `lane_defaults` ignore all of it). Spawned with `WORKER_CONCURRENCY: "1"` and the same
blocker-held corpus discipline as §5.6: 12 tasks — 4 `queued`, 1 `running`, 3 `ready` (one
collected), 2 `failed`, 2 `cancelled`; 7 scrape, 5 report — rebuilt per test, so every total is
hand-countable. The other three registered lanes carry no corpus tasks and must still appear,
zero-valued, in `counts.lane`.

1. **No filter**: `all === matching ===` the row count; `status.*` equals the hand-counted
   breakdown and `sum(status.*) === all` (the sidebar's "All" row renders that sum);
   `sum(lane.*) === all`; `uncollected` equals both the hand-counted 4 and the rows the page
   itself shows as `ready`/`failed` and uncollected.
2. **`?status=` alone**, all five values: the list returns *exactly* `counts.status[thatStatus]`
   rows; `status.*`, `all`, and `uncollected` are unchanged by the status filter; `lane.*` narrows
   to that status and sums to `matching`.
3. **`?lane=` alone**, both lanes: `matching` equals the row count; `all` and `lane.*` are
   unchanged; `status.*` and `uncollected` narrow to the lane and `sum(status.*) === matching`.
4. **`?status=&lane=` together**, all ten combinations including an empty one: rows ===
   `matching` === `status[thatStatus]` === `lane[thatLane]`, and `all` still moves for neither.
5. **A `from`/`to` window**: a bracket around the corpus changes nothing; an empty window zeroes
   every number while still carrying all five status keys, both registered lanes, and `lanes`;
   two complementary half-open windows split on a real `created_at` partition the register exactly
   (`before.all + after.all === all`), and inside each window every basis still holds.
6. **Cursor pages**: `counts` is present on every page of a `limit=5` chain and is identical page
   to page — `matching` is the whole matching set, never a page-local tally.
7. **A user with zero tasks** still receives the full registered-lane list (registration, not
   `SELECT DISTINCT lane`) and an all-zero, fully-keyed `counts` object, while the other user's
   register is unaffected — counts are per-user like every other read.
8. **`?uncollected=true` alone**: the rows returned are *exactly* `counts.uncollected` of the
   unfiltered response, and every one of them is `ready`/`failed` and uncollected; `matching`
   equals the row count; `all` and the `uncollected` count are both unchanged; `status.*` and
   `lane.*` narrow to the slice and each sums to `matching`.
9. **`?uncollected=true` combined with `?status=` and `?lane=`**, every combination including the
   three-way one: rows === `matching` throughout; `status.*` still ignores `status` while
   respecting `uncollected`; `lane.*` still ignores `lane`; the `uncollected` count respects
   `lane` (its documented basis) while ignoring the filter named after it.
10. **Rejected values**: `uncollected=` `false`/`1`/`0`/`TRUE`/`True`/`yes`/empty → `400`
    `invalid_params` each; only the literal string `true` is accepted (api-contract §7's rule that
    an invalid value is never silently ignored or clamped).

### 5.12 `flaky-outcomes`

`params.fail_times` and the attempt-aware worker context ([ADR 0021](./decisions/0021-flaky-outcomes-attempt-context-and-per-lane-durations.md)).
Baseline env (`BACKOFF_BASE_MS=100`), one server per file.

1. **`fail_times: 1`** -> the stream carries `retrying` (reason
   `"mock flaky failure: attempt 1 of 1 scheduled to fail via params.fail_times"`) and then
   `ready`, with **no** `failed` event anywhere; the final task is `ready` with `attempts: 2`,
   `error: null`, and `result.slept_ms === duration_ms`; the history endpoint shows exactly
   `accepted -> running(attempt 1) -> retrying(attempt 1) -> running(attempt 2) -> ready`. The
   worker's own reason text names attempt 1 and the engine journalled attempt 1 for the same
   claim — the cross-check that makes `ctx.attempt` observable from outside.
2. **`fail_times: 2`** -> two `retrying` hops, each naming its own attempt number, then `ready` on
   attempt 3.
3. **`fail_times` at or above the budget** (`fail_times: 3`, `max_attempts: 2`) -> the task
   exhausts its budget and lands in `failed` with `attempts: 2` and `retryable: true` — the budget
   ran out, not the possibility of success, which is what keeps the operator-retry offer honest.
4. **Precedence**: `fail_permanent` beats `fail_times` (one attempt, `retryable: false`); `fail`
   beats `fail_times` (fails on every attempt, so the recovery never happens).
5. **Validation**: `fail_times` of `0`, `10`, `-1`, `1.5`, `"1"`, `true`, `null` -> `400`
   `invalid_params` each; `1` and `9` -> `201` with the value echoed in stored params.
6. **The default outcome stays deterministic**: five submits carrying only `duration_ms` all reach
   `ready` with zero `failed` and zero `retrying` events, and none of them acquires an outcome
   param it was not given. Adding a flaky *outcome* must never make the *default* outcome flaky.

### 5.13 `lane-registry`

The five registered lanes and their per-lane defaults (api-contract §1, §6.2's `lane_defaults`,
[ADR 0021](./decisions/0021-flaky-outcomes-attempt-context-and-per-lane-durations.md)).

1. `counts.lanes` is exactly `["scrape","report","convert","build","test"]` — order is contract,
   because it is the order the sidebar and submit picker render. Each lane accepts a submit and
   numbers independently from 1 (`<lane>-1`). An unregistered lane is still `400 unknown_lane`.
2. `counts.lane_defaults` carries one entry per lane with that lane's real range — 3000-15000 for
   four of them, **20000-90000 for `build`** — its keys are in the same order as `counts.lanes`,
   and it is filter-invariant.
3. An omitted `duration_ms` lands inside the submitted lane's own range and is written into the
   **stored** params: six `build` submits are all inside 20000-90000 (disjoint from the default
   range, so a lane mix-up cannot hide behind an overlap), and the values echoed by a later list
   are the same values the creation responses carried — resolved once, not re-rolled per read.
4. An explicit `duration_ms` is honoured on `build` too, and extra params keys still pass through
   untouched.

### 5.14 `list-search`

The `?q=` free-text lookup ([ADR 0022](./decisions/0022-uncollected-and-search-list-filters.md)).
Corpus (15 tasks, rebuilt per test): `convert-1` ready+uncollected; `report-1` ready+**collected**
(a released former holder); a second `report-1` still holding the recycled handle; and `scrape-1`
through `scrape-12`, all long-running so they provably still hold their handles.

1. **Matching set**: `q=scrape` -> all 12 scrapes; `q=scrape-1` -> `scrape-1`, `scrape-10`,
   `scrape-11`, `scrape-12`; `q=scrape-12` -> one row; an exact id -> one row; an id prefix -> the
   target plus only rows sharing that prefix; `SCRAPE-12` and an upper-cased id match too
   (case-insensitive); a miss is an empty list, not a `404`.
2. **LIKE metacharacters are literal**: `scrape-%`, `%`, `_`, `scrape_1` and a trailing backslash
   all match **nothing**. Unescaped, the first two would return the whole register.
3. **User scoping**: Bob's `?q=` cannot see Alice's tasks, not even by her task's immutable id.
4. **Ranking**, all three tiers: `q=scrape-1` returns the exact match first and then the prefix
   matches newest-first; `q=scrape` (no exact match) is purely newest-first; `q=report-1` returns
   both holders with the **active** one first — and the released one is the older row, so this is
   not `created_at` ordering wearing a disguise.
5. **Unpaginated**: `next_cursor` is `null` whether or not rows were truncated; `?q=scrape&limit=5`
   returns the top 5 of the same ranking while `counts.matching` still reports 12; `as_of` still
   rides along so snapshot-then-stream hydration works from a search result.
6. **Composition** with `status`, `lane`, `uncollected`, and a `from`/`to` window.
7. **Count bases under `q`**: `matching`, `status.*` and `lane.*` narrow to the search; `all`,
   `uncollected`, `lanes` and `lane_defaults` do not.
8. **Refusals**: `q` + a real `cursor` -> `400` naming the cursor conflict; `q` + any `sort` ->
   `400` naming the sort conflict; `q` empty, whitespace-only, or 65 chars -> `400`; 64 chars is
   accepted, and surrounding whitespace is trimmed rather than counted.

---

## 6. Engine unit tests

`packages/engine/test/`, Vitest. Pure suites run in-process with no I/O; DB-backed suites use
`backburner_test_engine` (created/migrated by the package's global setup) and run serially.

| File | Type | Cases |
|---|---|---|
| `allocator.test.ts` | DB-backed | empty lane → 1; dense `{1..5}` active → 6; gapped `{1,3,4}` → 2; collect frees 2 in `{1,2,3}` → next is 2; same lane, two users → both get 1 (per-user namespace); same user, two lanes → both get 1 (per-lane numbering); `ready+collected` and `cancelled` rows are invisible to allocation; `failed` `{1}` uncollected → next is 2 (`failed`-uncollected is "finished-but-uncollected" per the spec's own wording, so it holds its handle exactly like `ready`-uncollected — the counterpart of the invisibility cases); `failed` `{1}` collected → next is 1 (collecting a failed task frees its handle exactly like collecting a ready one, so allocation reuses the freed number) |
| `backoff.test.ts` | pure | with injected RNG: nominal delays `base·2^(attempts−1)` = 100/200/400 for base 100; jitter bounded within ±25 % across the RNG's extremes; default base 2000 when unconfigured; property check: for attempts 1–10, delay ∈ [0.75, 1.25] · base·2^(n−1) |
| `dispatch-single-flight.test.ts` | pure (injected claim fn) | N concurrent `dispatch()` calls → claim rounds never interleave (single-flight mutex); a call arriving mid-run sets the dirty flag → exactly one trailing re-run, not N; with fake timers: a future `run_after` schedules exactly one wake-up at the earliest due time |
| `serializer.test.ts` | pure | `result` emitted only when `status === "ready"`, `error` only when `failed`, even when both columns hold historical values; handle derived as `lane + "-" + handle_num`, never read from storage; timestamps rendered ISO-8601 UTC with `Z`; the nine spec fields always present; additive fields (`id`, `attempts`, `max_attempts`, `seeded`) present and documented |

The engine's CAS transition guards, recovery, and event ordering are deliberately **not**
unit-tested in isolation — they are exactly what the criteria suite proves end-to-end, and a
mocked verdict on them would be weaker than the black-box one.

---

## 7. Continuous integration

`.github/workflows/ci.yml` runs two test jobs on every push and pull request, matching the build
plan's gate mechanics: `test` is a required check from Phase 0 onward; `criteria` is a visible
check that stays non-required until TDD Gate B promotes it — the criteria CI job flips from
non-blocking to required at that gate and stays required forever.

Since Phase 6 the same workflow carries a third job, `deploy`, which is not a test job and is
transcribed in [deployment.md](./deployment.md) §3 rather than here. It runs only on a push to
`main` and declares `needs: [test, criteria]`, so a red run of either suite below is structurally
un-deployable. It lives in this workflow rather than its own precisely so that gate is an
ordinary job dependency instead of a cross-workflow inference.

```yaml
name: ci
on: [push, pull_request]
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    services:
      postgres:
        image: postgres:18
        env:
          POSTGRES_PASSWORD: postgres
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run build
      - run: npm run test:unit
      - run: npm run test:supplemental
      - if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: server-logs-test
          path: packages/e2e/.logs
  criteria:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    services:
      postgres:
        image: postgres:18
        env:
          POSTGRES_PASSWORD: postgres
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm run test:criteria
      - if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: server-logs-criteria
          path: packages/e2e/.logs
```

Notes:

- `postgres:18` is required (native `uuidv7()`); each job's health check gates its first test
  step.
- The suites create and migrate their own databases (§3.2) — CI provides only a reachable server.
- The job split follows the npm script mapping in §2: `test` runs typecheck, build, engine unit,
  and the supplemental suites; `criteria` runs the nine reviewer checks in isolation, so its
  required/non-required status can flip at Gate B without touching the always-required job.
- Server logs from every spawned child are uploaded on failure in both jobs; a red CI run is
  always diagnosable without a rerun.
- No retries, no flaky-quarantine lane (§9). E2E wall time is dominated by criteria 06 and 09
  (~37 s and ~55 s respectively); the two jobs run in parallel and the 20-minute budget leaves
  ample headroom.

---

## 8. Running the suites

### Locally (Windows, macOS, Linux)

Prerequisites: Node 22, Docker (for Postgres 18). All scripts are cross-platform Node — no shell
dependencies, no WSL required.

```
docker compose up -d postgres     # dev compose database, localhost:5432
npm ci
npm run build
npm test                          # unit + e2e
npm run test:unit                 # engine unit tests only (fast)
npm run test:e2e                  # criteria + supplemental suites
```

- Defaults assume `postgres/postgres@localhost:5432`; point `E2E_DATABASE_URL` /
  `ENGINE_TEST_DATABASE_URL` elsewhere to override. Test databases are created automatically and
  never touch dev data.
- To run a single criterion: `npm run test:e2e -- criterion-09`.
- Windows note: on win32, `child.kill('SIGTERM')` is an unconditional hard kill — Node cannot
  deliver a catchable SIGTERM to a child process — so `stopServer`'s graceful-drain path is only
  genuinely exercisable on Linux (CI and the deploy target). The hard-kill path (`SIGKILL`) maps
  to `TerminateProcess`, so criterion 09 exercises true crash semantics identically on every
  platform.
- Per-test server logs land in `packages/e2e/.logs/` locally too.

### GitHub Codespaces

The devcontainer provides Node 22 and the compose Postgres; the commands above work unchanged.

### In CI

Nothing manual — §7 runs on every push. A PR is mergeable only with a fully green run.

---

## 9. Flakiness policy

This project's entire premise is correctness under concurrency; a test suite that shrugs at
intermittent failures would be self-refuting.

1. **`retry: 0`, everywhere, permanently.** A test that fails intermittently has found a bug — in
   the application or in the test — and the bug gets fixed. Rerun-to-green is not a fix.
2. **Every wait is event-driven with an explicit timeout** (§3.6). Blind sleeps are forbidden;
   the sole exception is the sentinel-bounded settle window inside `assertNever`.
3. **Negative assertions must carry sentinels.** An "X never arrived" claim without a
   later-arriving positive event proves only that the stream died quietly.
4. **Timing constants live in one file** and are changed only with a justifying comment. Upper
   bounds may be widened for CI; the spec's own bound (enqueue < 1 s) is never widened; lower
   bounds exist only to prove work genuinely ran and carry a 10 % tolerance.
5. **Failures are diagnosable from the first occurrence.** Wait helpers attach the buffered event
   list and the child server's log tail to every timeout error; CI uploads full server logs on
   failure. If a failure cannot be diagnosed from those artifacts, the harness's diagnostics are
   the first bug to fix.
6. **Skipping requires a tracked issue.** A test may be temporarily skipped only with a linked
   issue in the skip reason, and no test ships skipped in the submitted revision.
7. **Randomness is never asserted exactly.** Default worker durations and backoff jitter are
   random by design; tests pin `duration_ms` and assert jittered values as ranges.
