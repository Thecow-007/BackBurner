# Demo Runsheet

The recording plan for the assessment's deliverable: 15–30 minutes, two parts. Part 1 shows the working system; Part 2 walks the architecture across the spec's seven mandatory topics. [build-plan.md](./build-plan.md) Phase 7 is the authority on what must appear; this document is the shot list.

Every topic in Part 2 is hit **on camera** — the spec asks for them explicitly, and a reviewer should never have to infer that a topic was covered.

---

## Before you record

| Check | Why |
|---|---|
| `main` is green in Actions and the deploy job succeeded | The deployed commit must equal `main` HEAD |
| Production seeded, `daniel` and `newcomer` keys to hand | The register needs history; `newcomer` demonstrates empty states |
| Two terminals open, font size up (≥16pt) | Terminal text is the most-often-illegible part of a demo |
| Browser at `https://backburner.danielbierman.ca`, logged in as `daniel`, zoom ~110% | |
| Second browser window or tab for the mobile viewport (375px) | Responsive is a graded behaviour |
| Notifications not suppressed in the OS | Toasts are part of the demo |
| An SSH session to the server, already authenticated | Restart survival needs it live, mid-recording |
| Screen recorder capturing system audio, mic tested | One bad-audio take costs the whole runtime |

Set these once at the top of both terminals:

```bash
BASE=https://backburner.danielbierman.ca
KEY=<daniel's key>
```

**Do not** call `/tasks/{handle}/result` casually while setting up. Collect has a side effect — it flips `collected` and frees the handle. Save it for the moment you narrate it.

---

## Part 1 — The working system (~12–15 min)

### 1. Open cold (60s)

Land on the dashboard with the register already populated from the seed. Say what the system is in two sentences: submit a job, get a short recyclable handle back instantly, watch it run under a concurrency limit, collect the result.

Point out that every number on screen — per-status totals, per-lane totals, the uncollected count — comes from the server, not from counting the rows currently loaded. That is a deliberate honesty rule ([frontend-brief.md](./frontend-brief.md) §6.5), and it is why the counts stay correct under filtering and pagination.

### 2. The handle comes back instantly (90s)

Terminal 1, with the dashboard visible on screen at the same time:

```bash
time curl -s -X POST $BASE/tasks \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"lane":"scrape","params":{"duration_ms":30000}}'
```

Two things to name as they happen: the response returns in milliseconds carrying `handle` and `status: "queued"` for a job that will take 30 seconds, and the dashboard row appears **without a refresh and without polling**. This is success criterion 1.

Open the browser network inspector briefly and show a single long-lived `/events` connection and no polling loop. It is worth 15 seconds because it is the claim reviewers most expect to be false.

### 3. Live lifecycle across lanes (2 min)

Submit several at once, deliberately across lanes:

```bash
for lane in scrape report convert test; do
  curl -s -X POST $BASE/tasks -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    -d "{\"lane\":\"$lane\",\"params\":{\"duration_ms\":8000}}" >/dev/null
done
```

Narrate the per-lane numbering as the handles land: each lane numbers independently, so `scrape-3` and `report-1` coexist. Let one complete and show the toast plus the notification centre entry.

Then submit more than the concurrency limit and show that only `WORKER_CONCURRENCY` run at a time while the rest sit `queued` — the limit is enforced by the claim query, not by hope.

### 4. Cancel mid-run (90s)

Start a long one on the `build` lane (20–90 s by design), let it reach `running`, then cancel from the UI. Show the status flip to `cancelled` live, and make the point that cancellation actually **aborts the worker** through an `AbortController` — the job stops doing work, it is not merely marked cancelled and left running.

Cancel a `queued` one too. Both are legal; the state machine handles them by different paths.

### 5. Failure and operator retry (2 min)

```bash
curl -s -X POST $BASE/tasks -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"lane":"report","params":{"duration_ms":2000,"fail":true},"max_attempts":2}'
```

Watch it fail, back off, retry automatically, exhaust its budget, and land in `failed` with an honest reason. Open the task detail and walk the **attempt-grouped transition timeline** — this is the audit trail, and it is the same journal that feeds the SSE stream and its replay cursor.

Then hit operator retry on the failed task and show it run again.

Worth showing right after, because it is the more interesting case — the flaky job that recovers on its own:

```bash
curl -s -X POST $BASE/tasks -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"lane":"test","params":{"duration_ms":2000,"fail_times":2},"max_attempts":4}'
```

Fails twice, succeeds on the third attempt, all visible in the timeline.

### 6. Collect, and the handle recycles (2 min)

Pick a `ready` task and collect it — from the UI, then from curl:

```bash
curl -s $BASE/tasks/scrape-3/result -H "Authorization: Bearer $KEY"
```

Name the side effect out loud: collecting frees the handle. Then submit a new `scrape` job and show it **reusing that number**, while the old task still exists under its own immutable UUID. This is the subtlety the spec cares most about — handles are leases, ids are identity — and it is worth showing that `GET /tasks/{handle}` now resolves to the new holder while the old task is still reachable by id.

### 7. Restart survival, on camera (2–3 min)

The single most convincing thing in the demo. Submit several long jobs, let some reach `running`, then **hard-kill the server while they are in flight**:

```bash
# on the server
docker compose --profile prod kill app     # SIGKILL — a real crash, not a graceful stop
docker compose --profile prod up -d app
```

Show the dashboard reconnecting on its own, then show that the interrupted jobs were re-queued and run to completion — nothing is stranded in `running`, and nothing is silently lost. Say plainly that this is at-least-once: a crashed job is re-attempted, and the attempt counter reflects it.

This is success criterion 9, and it is the same code path the criteria suite exercises by SIGKILLing a child process mid-flight.

### 8. Direct REST, from outside (60s)

Close Part 1 by showing the API is genuinely open to a reviewer: a plain `curl` with a bearer key, ideally from a phone hotspot or a machine that is obviously not the server.

```bash
curl -s "$BASE/tasks?status=ready&limit=3" -H "Authorization: Bearer $KEY"
curl -N "$BASE/events" -H "Authorization: Bearer $KEY"     # let a heartbeat or two arrive
```

Mention the `: hb` heartbeat when it appears, and why it exists — Cloudflare culls streams idle for ~100 s, so a silent stream is a dead dashboard.

If time allows, log in as `newcomer` for 20 seconds to show every empty state is designed rather than blank.

---

## Part 2 — Architecture walkthrough (~12–15 min)

Roughly 2 minutes per topic. Have the docs open and jump to the named sections — showing the source material is part of the point, because it proves the design preceded the code.

| # | Topic | Show | Source |
|---|---|---|---|
| 1 | Orchestration engine design | The state machine and dispatch loop; every transition is a compare-and-swap, so a lost race is a `409` rather than corruption | [architecture.md](./architecture.md) §§7–8, [ADR 0003](./decisions/0003-event-driven-push-dispatch.md), [ADR 0005](./decisions/0005-cas-state-machine-plus-advisory-lock.md) |
| 2 | Handle assignment and recycling | Lowest-free-number allocation under a per-(user, lane) advisory lock, and the `one_active_handle` partial unique index that makes collisions structurally impossible rather than merely unlikely | [architecture.md](./architecture.md) §§4–6, [ADR 0001](./decisions/0001-postgres-as-handle-allocator.md), [ADR 0002](./decisions/0002-uuidv7-primary-key-handle-as-lease.md) |
| 3 | Concurrency model | `FOR UPDATE SKIP LOCKED` claims, in-process slot accounting, single-flight dispatch | [architecture.md](./architecture.md) §8, [ADR 0005](./decisions/0005-cas-state-machine-plus-advisory-lock.md) |
| 4 | Durability and restart strategy | The transition journal doing three jobs at once — history view, transactional outbox, SSE replay cursor — and boot recovery re-queueing or exhausting orphaned `running` rows | [architecture.md](./architecture.md) §11, [ADR 0004](./decisions/0004-transitions-table-as-history-outbox-and-sse-replay.md), [ADR 0006](./decisions/0006-at-least-once-recovery-attempts-at-claim.md) |
| 5 | Worker contract, and plugging in new workers | `(job, ctx) => Promise<WorkerResult>` with `ctx = { signal, attempt, maxAttempts }`; the lane registry; why a spec-shaped one-argument worker stays assignable | [architecture.md](./architecture.md) §§8–10, §2 |
| 6 | Key tradeoffs | Walk 3–4 ADRs, not all 29. Best set: SSE over WebSockets (0007), raw SQL over an ORM (0009), at-least-once over exactly-once (0006), and counts on the list response so a number can never disagree with the list it opens (0018) | [decisions/](./decisions/), [api-contract.md](./api-contract.md) §11 |
| 7 | What you would change with more time | Multi-process workers and what they'd actually require — recovery ownership via a lease, since claiming is *already* multi-process-safe; `LISTEN/NOTIFY` as a cross-process doorbell; per-lane concurrency as QoS; journal partitioning | [architecture.md](./architecture.md) §14 |

On topic 7, be concrete about the seam rather than vague about the future: claiming is already safe across processes, and the one thing blocking a second process is that boot recovery assumes it owns every `running` row. That specificity reads as having thought it through, where "I'd add horizontal scaling" does not.

---

## Worth mentioning if the clock allows

- **The TDD gates.** The nine criteria tests were committed **failing**, before any engine code existed, and the commit history proves the order. `git log --oneline` on camera makes the point in ten seconds.
- **Package boundaries as a hard rule.** The engine has zero HTTP dependencies; the API never runs its own SQL against engine-owned tables; the SPA is a pure API consumer. Enforced by review and visible in `package.json`.
- **The mock worker is deterministic.** With no outcome param a job always succeeds — never a server-side dice roll — which is exactly what keeps the criteria suite reproducible. The dashboard's "Random" option rolls its dice in the browser and submits explicit params ([ADR 0028](./decisions/0028-random-submit-outcomes-rolled-client-side.md)).
- **Mobile.** 30 seconds at a 375px viewport doing the two phone jobs: check what is running, submit a task.

## Do not

- Do not call collect casually while setting up a shot — it frees the handle and changes what the next shot shows.
- Do not read the ADR list aloud. Pick four that involved a real tradeoff and explain the losing side.
- Do not apologise for scope. Name the seams deliberately (topic 7) and move on.
