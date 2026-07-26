# BackBurner

BackBurner is a background job runner. Submit a job and get a short, recyclable handle back instantly (`scrape-1`), watch it run under a concurrency limit via a live SSE stream, then collect the result when it's done. It's built against the assessment spec at [`docs/assessment-background-job-runner.md`](./docs/assessment-background-job-runner.md) (a verbatim transcription of the PDF beside it), with every extension beyond the spec additively documented.

Stack: Node 22 + TypeScript, PostgreSQL 18 (`uuidv7()` is native), npm workspaces monorepo.

## Architecture

Four workspaces around one database:

| Package | Responsibility | May depend on |
|---|---|---|
| `@backburner/engine` | Orchestration core: handle allocation, the task state machine, dispatch, the worker pool, retries, recovery, the event log. Owns the `tasks` and `task_transitions` tables. **No HTTP dependencies.** | `pg` only |
| `@backburner/api` | Fastify server: auth, REST + SSE routes, validation, serves the built SPA in production. Owns the `users` table. | `@backburner/engine` |
| `@backburner/web` | React SPA — dashboard, submit, task detail, notifications. A **pure API consumer**. | nothing in this repo — `fetch` + `EventSource` only |
| `@backburner/e2e` | Black-box test suite; spawns the real API as a child process and drives it over HTTP/SSE. | none of the packages |

Package boundaries are absolute, not just convention:

- `@backburner/engine` never imports HTTP machinery and is the sole owner of `tasks`/`task_transitions` — no other package runs SQL against them.
- `@backburner/api` reaches engine state only through the engine's exported public surface (`createEngine(...)` → `submit`, `list`, `get`, `collect`, `cancel`, `retry`, `history`, `subscribe`); it never writes its own SQL against engine-owned tables. It owns `users`.
- `@backburner/web` never imports engine or api code and never touches the database — REST and `EventSource` are its entire interface to the system.
- `@backburner/e2e` is black-box: SQL is allowed only in test setup/teardown (truncate, seed test users), never in assertions.

**Schema, in brief.** `tasks` holds one row per job (`lane`, `handle_num`, `status`, `params`, `result`/`error`, `attempts`, `collected`, …); the public `handle` (`scrape-1`) is *derived* at read time from `lane` + `handle_num`, never stored as a string. `task_transitions` is an append-only journal — every state change writes a row in the same transaction as the `tasks` update, giving one mechanism that simultaneously serves the per-task history view, the SSE transactional outbox, and the replay cursor (its `bigint` identity column doubles as the SSE event id). A partial unique index, `one_active_handle`, enforces that at most one task per `(user, lane, handle_num)` is ever *active* (`queued`/`running`, or `ready`/`failed` and not yet collected) — handle collisions are structurally impossible at the database level, not just avoided in application code. Full detail: [`docs/architecture.md`](./docs/architecture.md).

```mermaid
flowchart LR
    web["@backburner/web<br/>React SPA"] -->|"fetch + EventSource only"| api["@backburner/api<br/>Fastify — auth, REST, SSE"]
    api -->|"engine public surface only"| engine["@backburner/engine<br/>allocator / state machine / dispatcher"]
    api -->|"owns users"| pg[("PostgreSQL 18")]
    engine -->|"owns tasks, task_transitions"| pg
```

## Prerequisites

- **Node 22** (`engines.node: ">=22"` in `package.json`)
- **Docker**, for PostgreSQL 18 via the repo's `docker-compose.yml`

Everything here runs unmodified on Windows, Linux, and GitHub Codespaces — all scripts are cross-platform Node (`scripts/*.mjs`), no bash-isms in any npm script.

## Local setup

```
docker compose up -d postgres      # dev database — postgres:18 on localhost:5432
npm ci
npm run build                      # builds engine, then api, then web, in dependency order
npm run migrate                    # scripts/migrate.mjs — idempotent, tracks schema_migrations
npm run seed -- --tasks 300        # seed data; prints raw API keys once (see Seeding, below)
npm run dev                        # api + Vite dev server (proxies /tasks, /events, /health)
```

`npm run migrate`, `npm run seed`, and the api process all read `DATABASE_URL` (and the other knobs below) directly from `process.env` — there's no automatic `.env` loading yet, so either export the variables in your shell or copy `.env.example` to `.env` and load it with your tool of choice. The default matches the compose service above:

```
# bash / zsh
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/backburner_dev

# PowerShell
$env:DATABASE_URL = "postgres://postgres:postgres@localhost:5432/backburner_dev"
```

## Configuration

All runtime configuration is by environment variable (`.env.example` is the template; see [`docs/architecture.md`](./docs/architecture.md) §13):

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — (required) | PostgreSQL connection string |
| `PORT` | `3000` | HTTP listen port for the api |
| `WORKER_CONCURRENCY` | `4` | Maximum concurrently running workers |
| `BACKOFF_BASE_MS` | `2000` | Retry backoff base; `delay = base * 2^(attempts-1)` ±25% jitter |
| `SSE_HEARTBEAT_MS` | `20000` | Interval for the `: hb` SSE heartbeat comment (keeps proxies from dropping idle streams) |
| `DRAIN_TIMEOUT_MS` | `30000` | Bound on the graceful-drain window in `stop({ drain })` before remaining workers are aborted |
| `NODE_ENV` | — | Standard Node environment flag |

**Worker pool and mock worker.** `WORKER_CONCURRENCY` caps how many workers run at once, enforced by `FOR UPDATE SKIP LOCKED` claims. Two lanes are registered out of the box — `scrape` and `report` — both backed by a mock worker driven entirely by `params`:

- `duration_ms` (integer, 1–600000) — how long the job sleeps. Omitted: a random duration between 3000–15000 ms is chosen once at submit and written back into the stored `params`, so retries reuse the same value deterministically.
- `fail: true` — returns a **retryable** failure.
- `fail_permanent: true` — returns a **non-retryable** failure (straight to `failed`, attempt budget ignored; wins if both flags are set). Operator retry remains available afterward regardless of `retryable`.

Extra `params` keys pass through to the worker untouched.

## API surface

Full normative contract: [`docs/api-contract.md`](./docs/api-contract.md). Summary:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/tasks` | Bearer | **[SPEC]** Enqueue a job; returns the task object immediately |
| GET | `/tasks` | Bearer | **[SPEC]** List tasks; filters, sort, pagination |
| GET | `/tasks/{handle}` | Bearer | **[SPEC]** Fetch one task by handle |
| GET | `/tasks/{handle}/result` | Bearer | **[SPEC]** Fetch the result; marks the task collected |
| POST | `/tasks/{handle}/cancel` | Bearer | **[SPEC]** Cancel a queued or running task |
| POST | `/tasks/{handle}/retry` | Bearer | **[EXTENSION]** Operator retry of a failed task |
| GET | `/tasks/id/{id}` | Bearer | **[EXTENSION]** Fetch one task by immutable id |
| GET | `/tasks/id/{id}/history` | Bearer | **[EXTENSION]** Full state-transition history of a task |
| GET | `/events` | Bearer or `?api_key=` | **[SPEC]** SSE stream of lifecycle events |
| GET | `/health` | none | **[EXTENSION]** Liveness probe |

**Auth.** Every endpoint except `GET /health` requires `Authorization: Bearer <api key>`. Keys have the form `bb_` + 40 lowercase hex characters; only their SHA-256 hash is stored server-side, and raw keys are printed exactly once, by `npm run seed`. `GET /events` additionally accepts the key as `?api_key=<key>`, since a browser `EventSource` can't set headers — if both are supplied, the header wins.

**curl quickstart** (adapted from [`docs/api-contract.md`](./docs/api-contract.md) §10):

```bash
BASE=http://localhost:3000
KEY=bb_9f2ce4a1b7d8036c5e12f409ab87cd3210fe6b54   # printed by npm run seed

curl -s $BASE/health                                                   # liveness, no auth

curl -s -X POST $BASE/tasks \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"lane":"scrape","params":{"duration_ms":10000}}'                # submit a job

curl -s $BASE/tasks/scrape-1 -H "Authorization: Bearer $KEY"           # fetch by handle
curl -N "$BASE/events?since=0" -H "Authorization: Bearer $KEY"         # watch the live stream
curl -s $BASE/tasks/scrape-1/result -H "Authorization: Bearer $KEY"    # collect (side effect!)
curl -s -X POST $BASE/tasks/scrape-1/cancel -H "Authorization: Bearer $KEY"
curl -s -X POST $BASE/tasks/report-1/retry -H "Authorization: Bearer $KEY"
```

`GET /tasks/{handle}/result` has a side effect — it flips `collected` and frees the handle — so it should only ever be called on an explicit user/operator action, never automatically.

## Seeding

```
npm run seed -- --tasks 300 --from 2026-04-01 --to 2026-07-21
npm run seed -- --reset
```

`--tasks` (default 300), `--from`/`--to` (default: `to` = now, `from` = 90 days earlier) generate backdated tasks with coherent synthetic transition histories, spread across every terminal status (`ready`, `failed`, `cancelled`) — deliberately **no** seeded `queued` or `running` rows, since those would be falsified the moment the server restarts and boot recovery runs. Every seeded row carries `seeded: true`. Handles are allocated through the real allocator, so seeded data can never violate the one-active-handle invariant, and it coexists safely with real submissions. Two users are seeded, `daniel` and `reviewer`; their raw API keys (`bb_` + 40 hex) are printed **once**, to stdout, and never recoverable afterward. `--reset` deletes seeded tasks/transitions only and upserts (never deletes) the seed users.

## Running the tests

```
npm test                           # unit + e2e (everything)
npm run test:unit                  # engine unit tests only (fast)
npm run test:criteria              # the 9 spec success-criteria checks
npm run test:supplemental          # contract-defense e2e suites
npm run test:e2e -- criterion-09   # a single criterion
```

Requires the same Docker Postgres 18 as local setup; the e2e and engine test suites each create and migrate their own dedicated test database automatically (`backburner_test_e2e`, `backburner_test_engine`) — they never touch dev data. Test timing knobs (`BACKOFF_BASE_MS=100`, `WORKER_CONCURRENCY`, `DRAIN_TIMEOUT_MS`) are set by the harness itself; see [`docs/test-plan.md`](./docs/test-plan.md) §3.4. The criteria suite is the executable form of the assessment's nine success criteria; the supplemental suites defend the rest of the contract (auth isolation, the invalid-transition matrix, the allocator under concurrent load, SSE replay, pagination, seed smoke, and more) — full inventory in [`docs/test-plan.md`](./docs/test-plan.md) §2.

## GitHub Codespaces

The devcontainer (`.devcontainer/devcontainer.json`) reuses the same `docker-compose.yml`, provisions Node 22 and a Postgres 18 service, and runs `npm ci` on create. Every command above works unchanged inside a Codespace — there is no separate Codespaces-only setup path.

## Project status

**Complete and green:** the engine (`@backburner/engine`), the full HTTP + SSE API (`@backburner/api`), seeding, and the automated test matrix — the 9 criteria tests, 10 supplemental contract-defense suites, and the engine unit suites.

**Not yet built:** the React dashboard (`@backburner/web`) is fully specified in [`docs/frontend-brief.md`](./docs/frontend-brief.md) but not yet implemented — it's the next milestone. There is no deployed URL yet; production topology is designed in [`docs/deployment.md`](./docs/deployment.md) and lands once the frontend is in place.

**Normative docs** (the design authority for everything above):

| Document | Covers |
|---|---|
| [`docs/architecture.md`](./docs/architecture.md) | Engine and system design: schema, handle allocation, state machine, dispatch, cancellation, recovery |
| [`docs/api-contract.md`](./docs/api-contract.md) | The full HTTP surface: endpoints, task object, error envelope, SSE wire format, spec-ambiguity resolutions |
| [`docs/test-plan.md`](./docs/test-plan.md) | All test suites, timing constants, CI, flakiness policy |
| [`docs/frontend-brief.md`](./docs/frontend-brief.md) | The SPA: screens, store discipline, action matrix |
| [`docs/build-plan.md`](./docs/build-plan.md) | Build phases, gates, working agreements |
| [`docs/deployment.md`](./docs/deployment.md) | Production topology, deploy pipeline, Cloudflare, secrets |
| [`docs/decisions/`](./docs/decisions/) | ADRs — the rationale behind every hard-to-reverse choice |
