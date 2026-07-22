# CLAUDE.md

BackBurner is a background job runner: submit a job, get a short recyclable handle (`scrape-1`) back instantly, watch it run under a concurrency limit via SSE, collect the result. Node 22 + TypeScript, PostgreSQL 18, npm workspaces monorepo. Built against the assessment spec at `docs/assessment-background-job-runner.md` (verbatim transcription; the PDF beside it is the original).

## Doc map — the docs are law

| Document | Normative for |
|---|---|
| `docs/architecture.md` | Engine and system design: schema, handle allocation, state machine, dispatch, cancellation, recovery, engine public surface |
| `docs/api-contract.md` | The entire HTTP surface: endpoints, task object, error envelope, SSE wire format, handle resolution, spec-ambiguity resolutions |
| `docs/test-plan.md` | All test suites: the 9 criteria tests, supplemental e2e, engine unit tests, harness, timing constants, CI, flakiness policy |
| `docs/frontend-brief.md` | The SPA: screens, store discipline, action matrix, notifications, responsive rules |
| `docs/build-plan.md` | Build phases, gates, working agreements, commit conventions |
| `docs/deployment.md` | Production topology, deploy pipeline, Cloudflare, secrets |
| `docs/decisions/` | ADRs — the rationale behind every hard-to-reverse choice |

When a decision is not pinned by these docs or the spec PDF, stop and ask — never guess and build on the guess.

## Iron rules

- **Spec shapes are byte-for-byte.** The six spec endpoint paths, nine task-object fields, four spec event shapes, and five-value status enum are never renamed, reshaped, or "improved." Everything else is additive and documented as an extension (`api-contract.md` badges every one).
- **Package boundaries are absolute.**
  - `@backburner/engine`: no HTTP dependencies; sole owner of `tasks` and `task_transitions`.
  - `@backburner/api`: reaches engine tables only through the engine's public surface — never its own SQL against them. Owns `users` only.
  - `@backburner/web`: pure API consumer — `fetch` + `EventSource` only; never imports engine/api code, never touches the database.
  - `@backburner/e2e`: black-box; SQL in setup/teardown only, never in assertions.
- **TDD gates (build-plan).** The 9 criteria tests are committed failing before any engine code (Gate A) and must be green before any web work (Gate B). Criteria tests are never edited to fit an implementation; if test and code disagree, the test is presumed right and the spec PDF is the tiebreaker.
- **Deviations require an ADR.** Any departure from the docs, however small, needs a new record in `docs/decisions/` plus an explicit flag in the commit/PR. Silent drift is a defect.
- **Cross-platform always.** Everything runs on Windows, Linux, and Codespaces. npm scripts contain no bash-isms; non-trivial scripts are Node (`scripts/*.mjs`). Migrations are append-only numbered `.sql` files in root `migrations/`.

## Commands

```
docker compose up -d postgres      # dev database (postgres:18, localhost:5432)
npm ci && npm run build            # engine builds before api
npm run migrate                    # scripts/migrate.mjs — idempotent, tracks schema_migrations
npm test                           # unit + e2e
npm run test:unit                  # engine unit tests (fast)
npm run test:criteria              # the 9 reviewer checks
npm run test:supplemental          # contract-defense e2e suites
npm run test:e2e -- criterion-09   # single criterion
npm run seed -- --tasks 300        # seed data; prints raw API keys once; --reset removes seeded rows only
npm run dev                        # api + Vite dev server (proxies /tasks, /events, /health)
```

Test env knobs: `BACKOFF_BASE_MS=100`, `WORKER_CONCURRENCY`, `DRAIN_TIMEOUT_MS` — see `test-plan.md` §3.4.

## Gotchas

- **Collect has a side effect.** `GET /tasks/{handle}/result` flips `collected`, frees the handle, and emits an event. Never call it automatically — not in UI renders, not as a convenience fetch. Explicit user/operator action only.
- **Handles recycle; `id` does not.** `scrape-1` can name different tasks over time. Correlate events, build links, and store references by `task_id`/`id` (UUIDv7); treat the handle as a display alias. Resolution: active holder wins, else most recent former holder, else 404.
- **SSE needs the heartbeat.** Cloudflare drops streams idle ~100 s; the `: hb` comment every `SSE_HEARTBEAT_MS` (20 s) is load-bearing, not cosmetic. Reconnects resume via `Last-Event-ID`/`?since` against the transitions journal.
- **The mock worker is driven by params.** `params.duration_ms` (1–600000) sets the sleep; omitted, a random 3000–15000 ms is chosen at submit and written back into stored params so retries are deterministic. `params.fail: true` returns a retryable failure; `params.fail_permanent: true` a non-retryable one (straight to `failed`, budget ignored; operator retry still allowed). Extra params keys pass through untouched.
- **Every state change is a CAS.** Zero rows updated means the transition lost a race → `InvalidStateError` → `409` with `current_status`. Never read-then-write status; never add a transition outside the table in `architecture.md` §7.
- **Transition journal rows commit in the same transaction as the state change.** Broadcast only after commit. This is the outbox, the history endpoint, and the SSE replay cursor — do not write events any other way.
