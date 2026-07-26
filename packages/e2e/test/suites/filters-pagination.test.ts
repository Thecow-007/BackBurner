import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ALICE,
  BOB,
  EventCapture,
  T_EVENT,
  T_JOB,
  cancel,
  collect,
  listTasks,
  resetDatabase,
  retry,
  settle,
  spawnServer,
  stopServer,
  submit,
  type ErrorEnvelope,
  type ServerHandle,
  type TaskListResponse,
  type TaskObject,
  type TaskStatus,
} from "../../src/index.js";

/**
 * Supplemental suite 5.6 — filters, sort, pagination, and `as_of`
 * (test-plan.md §5.6; api-contract.md §7). Spawns with
 * `WORKER_CONCURRENCY: "1"` so a single long "blocker" task can hold the
 * lone worker slot and force a handful of freshly submitted tasks to sit
 * provably `queued` behind it.
 *
 * ── Canonical supplemental-suite lifecycle (test-plan.md §3.1-§3.2) ──
 * One server per FILE (spawned in `beforeAll`, stopped in `afterAll`).
 * Between tests, `settle()` cancels every `queued`/`running` task through the
 * API so the worker pool is provably idle, and only THEN is the database
 * truncated. `settle()` needs a live per-user `EventCapture` to await the
 * `cancelled` events it triggers.
 *
 * ── Corpus (test-plan.md §5.6) ──
 * ~12 tasks across both lanes, built fresh per test via `buildCorpus()`.
 * Build order matters under `WORKER_CONCURRENCY: "1"`: the terminal-state
 * tasks (ready / ready+collected / failed / cancelled) are driven with SHORT
 * durations and awaited to their terminal state first, one at a time on the
 * single worker — only THEN does a `duration_ms: 30000` blocker claim the
 * lone slot, after which a handful more submissions are provably stuck
 * `queued` behind it for the rest of the test.
 */
describe("filters-pagination", () => {
  let server: ServerHandle;

  beforeAll(async () => {
    server = await spawnServer({ WORKER_CONCURRENCY: "1" });
  });

  afterAll(async () => {
    await stopServer(server);
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
    // Drain in-flight work for both actors before the next truncation. A
    // short-lived per-user capture lets settle() await the cancelled events.
    for (const user of [ALICE, BOB]) {
      const cap = new EventCapture(server.baseUrl, user.rawKey, { server });
      await cap.ready;
      await settle(server.baseUrl, user.rawKey, cap, { server });
      cap.close();
    }
  });

  // ── Corpus construction ──────────────────────────────────────────────

  /** Short enough that ready/failed corpus tasks actually finish quickly on
   * the lone worker, long enough to be a real, observable run. */
  const SHORT_MS = 300;
  /** Long enough that the cancel() call below always lands on a still
   * queued-or-running task, never a race against natural completion. */
  const CANCEL_MS = 5000;
  /** Duration for tasks left sitting behind the blocker — never runs during
   * the test, so the exact value is immaterial. */
  const QUEUED_MS = 5000;
  /** Long enough to hold `WORKER_CONCURRENCY: "1"`'s one slot for an entire
   * test's corpus build + assertions (test-plan.md §5.6). */
  const BLOCKER_MS = 30_000;

  interface CorpusTask {
    id: string;
    handle: string;
    lane: string;
  }

  interface Corpus {
    readyScrape: CorpusTask;
    readyScrapeCollected: CorpusTask;
    readyReport: CorpusTask;
    failedScrape: CorpusTask;
    failedReport: CorpusTask;
    cancelledScrape: CorpusTask;
    cancelledReport: CorpusTask;
    blocker: CorpusTask;
    queuedScrape: CorpusTask[];
    queuedReport: CorpusTask[];
    /** All 12, in creation order. */
    all: CorpusTask[];
    byStatus: Record<TaskStatus, CorpusTask[]>;
    byLane: Record<string, CorpusTask[]>;
  }

  async function submitTask(
    lane: string,
    params: Record<string, unknown>,
    maxAttempts?: number
  ): Promise<CorpusTask> {
    const body: Record<string, unknown> = { lane, params };
    if (maxAttempts !== undefined) body.max_attempts = maxAttempts;
    const res = await submit(server.baseUrl, ALICE.rawKey, body);
    expect(res.status, `submit ${lane}`).toBe(201);
    const task = res.body as TaskObject;
    return { id: task.id, handle: task.handle, lane: task.lane };
  }

  async function makeReady(cap: EventCapture, lane: string): Promise<CorpusTask> {
    const task = await submitTask(lane, { duration_ms: SHORT_MS });
    await cap.waitFor(
      (e) => e.type === "ready" && e.task_id === task.id,
      T_JOB(SHORT_MS),
      `ready for ${task.handle} (task_id=${task.id})`,
      server
    );
    return task;
  }

  async function makeReadyCollected(cap: EventCapture, lane: string): Promise<CorpusTask> {
    const task = await makeReady(cap, lane);
    const res = await collect(server.baseUrl, ALICE.rawKey, task.handle);
    expect(res.status, `collect ${task.handle}`).toBe(200);
    await cap.waitFor(
      (e) => e.type === "collected" && e.task_id === task.id,
      T_EVENT,
      `collected for ${task.handle} (task_id=${task.id})`,
      server
    );
    return task;
  }

  async function makeFailed(cap: EventCapture, lane: string): Promise<CorpusTask> {
    // max_attempts: 1 — the single retryable failure exhausts the budget
    // immediately, landing directly in `failed` with no auto-retry hop.
    const task = await submitTask(lane, { duration_ms: SHORT_MS, fail: true }, 1);
    await cap.waitFor(
      (e) => e.type === "failed" && e.task_id === task.id,
      T_JOB(SHORT_MS),
      `failed for ${task.handle} (task_id=${task.id})`,
      server
    );
    return task;
  }

  async function makeCancelled(cap: EventCapture, lane: string): Promise<CorpusTask> {
    const task = await submitTask(lane, { duration_ms: CANCEL_MS });
    const res = await cancel(server.baseUrl, ALICE.rawKey, task.handle);
    expect(res.status, `cancel ${task.handle}`).toBe(200);
    await cap.waitFor(
      (e) => e.type === "cancelled" && e.task_id === task.id,
      T_EVENT,
      `cancelled for ${task.handle} (task_id=${task.id})`,
      server
    );
    return task;
  }

  async function makeBlocker(cap: EventCapture, lane: string): Promise<CorpusTask> {
    const task = await submitTask(lane, { duration_ms: BLOCKER_MS });
    await cap.waitFor(
      (e) => e.type === "running" && e.task_id === task.id,
      T_EVENT,
      `running (blocker) for ${task.handle} (task_id=${task.id})`,
      server
    );
    return task;
  }

  async function makeQueued(cap: EventCapture, lane: string): Promise<CorpusTask> {
    const task = await submitTask(lane, { duration_ms: QUEUED_MS });
    await cap.waitFor(
      (e) => e.type === "accepted" && e.task_id === task.id,
      T_EVENT,
      `accepted for ${task.handle} (task_id=${task.id})`,
      server
    );
    return task;
  }

  async function buildCorpus(cap: EventCapture): Promise<Corpus> {
    // Terminal states first (test-plan.md §5.6 build order): with a single
    // worker these must fully resolve, one at a time, before the blocker
    // claims the only slot — otherwise they would never actually complete.
    const readyScrape = await makeReady(cap, "scrape");
    const readyScrapeCollected = await makeReadyCollected(cap, "scrape");
    const readyReport = await makeReady(cap, "report");
    const failedScrape = await makeFailed(cap, "scrape");
    const failedReport = await makeFailed(cap, "report");
    const cancelledScrape = await makeCancelled(cap, "scrape");
    const cancelledReport = await makeCancelled(cap, "report");

    // Now the blocker claims the lone worker slot; everything submitted
    // after it is driven into `queued` and stays there for the rest of the
    // test (the blocker's 30s comfortably outlasts any single test's
    // corpus-build + assertion time).
    const blocker = await makeBlocker(cap, "scrape");
    const queuedScrape = [await makeQueued(cap, "scrape"), await makeQueued(cap, "scrape")];
    const queuedReport = [await makeQueued(cap, "report"), await makeQueued(cap, "report")];

    const all = [
      readyScrape,
      readyScrapeCollected,
      readyReport,
      failedScrape,
      failedReport,
      cancelledScrape,
      cancelledReport,
      blocker,
      ...queuedScrape,
      ...queuedReport,
    ];

    return {
      readyScrape,
      readyScrapeCollected,
      readyReport,
      failedScrape,
      failedReport,
      cancelledScrape,
      cancelledReport,
      blocker,
      queuedScrape,
      queuedReport,
      all,
      byStatus: {
        queued: [...queuedScrape, ...queuedReport],
        running: [blocker],
        ready: [readyScrape, readyScrapeCollected, readyReport],
        failed: [failedScrape, failedReport],
        cancelled: [cancelledScrape, cancelledReport],
      },
      byLane: {
        scrape: [readyScrape, readyScrapeCollected, failedScrape, cancelledScrape, blocker, ...queuedScrape],
        report: [readyReport, failedReport, cancelledReport, ...queuedReport],
      },
    };
  }

  function sortedIds(tasks: Array<{ id: string }>): string[] {
    return tasks.map((t) => t.id).sort();
  }

  // ── Tests ───────────────────────────────────────────────────────────

  it("?status= returns exactly the tasks in that status, for all five values", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    const corpus = await buildCorpus(cap);

    const statuses: TaskStatus[] = ["queued", "running", "ready", "failed", "cancelled"];
    for (const status of statuses) {
      const res = await listTasks(server.baseUrl, ALICE.rawKey, { status, limit: 200 });
      expect(res.status, status).toBe(200);
      const body = res.body as TaskListResponse;
      expect(sortedIds(body.tasks), status).toEqual(sortedIds(corpus.byStatus[status]));
      expect(
        body.tasks.every((t) => t.status === status),
        status
      ).toBe(true);
    }

    cap.close();
  });

  it("?lane= returns exactly the tasks in that lane", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    const corpus = await buildCorpus(cap);

    for (const lane of ["scrape", "report"] as const) {
      const res = await listTasks(server.baseUrl, ALICE.rawKey, { lane, limit: 200 });
      expect(res.status, lane).toBe(200);
      const body = res.body as TaskListResponse;
      expect(sortedIds(body.tasks), lane).toEqual(sortedIds(corpus.byLane[lane] ?? []));
      expect(
        body.tasks.every((t) => t.lane === lane),
        lane
      ).toBe(true);
    }

    cap.close();
  });

  it("combined ?status=&lane= intersects both filters", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    const corpus = await buildCorpus(cap);

    const cases: Array<{ status: TaskStatus; lane: string; expected: CorpusTask[] }> = [
      { status: "ready", lane: "scrape", expected: [corpus.readyScrape, corpus.readyScrapeCollected] },
      { status: "ready", lane: "report", expected: [corpus.readyReport] },
      { status: "queued", lane: "report", expected: corpus.queuedReport },
      { status: "queued", lane: "scrape", expected: corpus.queuedScrape },
      { status: "running", lane: "scrape", expected: [corpus.blocker] },
      { status: "running", lane: "report", expected: [] },
      { status: "failed", lane: "report", expected: [corpus.failedReport] },
      { status: "cancelled", lane: "scrape", expected: [corpus.cancelledScrape] },
    ];

    for (const c of cases) {
      const res = await listTasks(server.baseUrl, ALICE.rawKey, { status: c.status, lane: c.lane, limit: 200 });
      const label = `${c.status}+${c.lane}`;
      expect(res.status, label).toBe(200);
      const body = res.body as TaskListResponse;
      expect(sortedIds(body.tasks), label).toEqual(sortedIds(c.expected));
    }

    cap.close();
  });

  it("?from=/?to= filter created_at with inclusive/exclusive bracketing semantics", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    const corpus = await buildCorpus(cap);

    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const hourAhead = new Date(Date.now() + 3600_000).toISOString();

    // from = one hour ago (inclusive, created_at >= from) → every task, all
    // created within the last few seconds of corpus construction.
    const fromPast = await listTasks(server.baseUrl, ALICE.rawKey, { from: hourAgo, limit: 200 });
    expect(fromPast.status).toBe(200);
    expect(sortedIds((fromPast.body as TaskListResponse).tasks)).toEqual(sortedIds(corpus.all));

    // to = one hour ago (exclusive, created_at < to) → nothing qualifies.
    const toPast = await listTasks(server.baseUrl, ALICE.rawKey, { to: hourAgo, limit: 200 });
    expect(toPast.status).toBe(200);
    expect((toPast.body as TaskListResponse).tasks).toEqual([]);

    // A bracketing [1h ago, 1h ahead) pair → every task again.
    const bracket = await listTasks(server.baseUrl, ALICE.rawKey, { from: hourAgo, to: hourAhead, limit: 200 });
    expect(bracket.status).toBe(200);
    expect(sortedIds((bracket.body as TaskListResponse).tasks)).toEqual(sortedIds(corpus.all));

    cap.close();
  });

  it("?sort=created_at:asc|desc orders by created_at with an id tiebreak; default matches :desc", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    const corpus = await buildCorpus(cap);
    const expectedIds = sortedIds(corpus.all);

    const ascRes = await listTasks(server.baseUrl, ALICE.rawKey, { sort: "created_at:asc", limit: 200 });
    const descRes = await listTasks(server.baseUrl, ALICE.rawKey, { sort: "created_at:desc", limit: 200 });
    const defaultRes = await listTasks(server.baseUrl, ALICE.rawKey, { limit: 200 });

    expect(ascRes.status).toBe(200);
    expect(descRes.status).toBe(200);
    expect(defaultRes.status).toBe(200);

    const asc = (ascRes.body as TaskListResponse).tasks;
    const desc = (descRes.body as TaskListResponse).tasks;
    const dflt = (defaultRes.body as TaskListResponse).tasks;

    // Full set, no loss or duplication, in either direction.
    expect(sortedIds(asc)).toEqual(expectedIds);
    expect(sortedIds(desc)).toEqual(expectedIds);

    // Monotonic by created_at; ties broken by id in the sort's own direction.
    for (let i = 0; i + 1 < asc.length; i++) {
      const a = asc[i]!;
      const b = asc[i + 1]!;
      expect(a.created_at <= b.created_at, `asc[${i}] vs [${i + 1}]`).toBe(true);
      if (a.created_at === b.created_at) {
        expect(a.id < b.id, `asc tie-break at [${i}]`).toBe(true);
      }
    }
    for (let i = 0; i + 1 < desc.length; i++) {
      const a = desc[i]!;
      const b = desc[i + 1]!;
      expect(a.created_at >= b.created_at, `desc[${i}] vs [${i + 1}]`).toBe(true);
      if (a.created_at === b.created_at) {
        expect(a.id > b.id, `desc tie-break at [${i}]`).toBe(true);
      }
    }

    // asc reversed is exactly desc — same total order, opposite traversal.
    expect(asc.map((t) => t.id).reverse()).toEqual(desc.map((t) => t.id));

    // Default sort is created_at:desc.
    expect(dflt.map((t) => t.id)).toEqual(desc.map((t) => t.id));

    cap.close();
  });

  it("?sort=updated_at:desc moves a freshly retried task to the front", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    const corpus = await buildCorpus(cap);

    const before = await listTasks(server.baseUrl, ALICE.rawKey, { sort: "updated_at:desc", limit: 200 });
    expect(before.status).toBe(200);
    const beforeIds = (before.body as TaskListResponse).tasks.map((t) => t.id);
    // failedReport transitioned to `failed` early in corpus construction —
    // seven later tasks (both cancels, the blocker, and four queued
    // submissions) all have a more recent updated_at, so it starts out well
    // back from the front.
    expect(beforeIds).toContain(corpus.failedReport.id);
    expect(beforeIds[0]).not.toBe(corpus.failedReport.id);

    // Operator retry of a failed, uncollected task (api-contract §6.6).
    const retryRes = await retry(server.baseUrl, ALICE.rawKey, corpus.failedReport.handle);
    expect(retryRes.status).toBe(200);
    expect((retryRes.body as TaskObject).status).toBe("queued");

    const after = await listTasks(server.baseUrl, ALICE.rawKey, { sort: "updated_at:desc", limit: 200 });
    expect(after.status).toBe(200);
    const afterTasks = (after.body as TaskListResponse).tasks;
    expect(afterTasks[0]?.id).toBe(corpus.failedReport.id);
    // Still the same 12 tasks — retry transitions in place, it does not add
    // or remove a row.
    expect(afterTasks.map((t) => t.id).sort()).toEqual(sortedIds(corpus.all));

    cap.close();
  });

  it("invalid ?sort= is rejected with 400 invalid_params", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    await buildCorpus(cap);

    const res = await listTasks(server.baseUrl, ALICE.rawKey, { sort: "bogus" });
    expect(res.status).toBe(400);
    expect((res.body as ErrorEnvelope).error.code).toBe("invalid_params");

    cap.close();
  });

  it("?limit=5 walks the full cursor chain with no gaps, no duplicates, and stable order; ?limit=201 is rejected", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    const corpus = await buildCorpus(cap);

    // Ground truth: the full, unpaginated order (default sort).
    const fullRes = await listTasks(server.baseUrl, ALICE.rawKey, { limit: 200 });
    expect(fullRes.status).toBe(200);
    const fullOrder = (fullRes.body as TaskListResponse).tasks.map((t) => t.id);
    expect(fullOrder.length).toBe(corpus.all.length);

    const seen: string[] = [];
    let cursor: string | undefined;
    let page = 0;
    for (;;) {
      page += 1;
      expect(page, "cursor chain did not terminate").toBeLessThanOrEqual(10);

      const res = await listTasks(server.baseUrl, ALICE.rawKey, { limit: 5, cursor });
      expect(res.status, `page ${page}`).toBe(200);
      const body = res.body as TaskListResponse;

      if (page === 1) {
        expect(body.tasks.length, "first page size").toBe(5);
        expect(body.next_cursor, "first page next_cursor").not.toBeNull();
      }

      seen.push(...body.tasks.map((t) => t.id));

      if (body.next_cursor === null) {
        expect(body.tasks.length, "final page size").toBe(corpus.all.length % 5);
        break;
      }
      expect(body.tasks.length, `page ${page} size`).toBe(5);
      cursor = body.next_cursor;
    }

    // Every task exactly once (no gaps, no duplicates → pages disjoint).
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual(sortedIds(corpus.all));
    // Order stable across pagination and matches the unpaginated snapshot.
    expect(seen).toEqual(fullOrder);

    const badLimit = await listTasks(server.baseUrl, ALICE.rawKey, { limit: 201 });
    expect(badLimit.status).toBe(400);
    expect((badLimit.body as ErrorEnvelope).error.code).toBe("invalid_params");

    cap.close();
  });

  it("as_of is present on every list response and is >= the last SSE id observed before the call", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    await buildCorpus(cap);

    const observedIds = cap.all().map((e) => e.id);
    const observedMax = observedIds.length > 0 ? Math.max(...observedIds) : 0;
    expect(observedMax, "corpus construction should have produced observed events").toBeGreaterThan(0);

    const res = await listTasks(server.baseUrl, ALICE.rawKey, { limit: 200 });
    expect(res.status).toBe(200);
    const body = res.body as TaskListResponse;
    expect(typeof body.as_of).toBe("number");
    expect(body.as_of).toBeGreaterThanOrEqual(observedMax);

    // The snapshot-to-stream bridge tracks forward: a fresh event pushes
    // as_of at least as far as its own SSE id (api-contract §7).
    const priorAsOf = body.as_of;
    const extra = await submit(server.baseUrl, ALICE.rawKey, { lane: "scrape", params: { duration_ms: QUEUED_MS } });
    expect(extra.status).toBe(201);
    const extraTask = extra.body as TaskObject;
    const acceptedEvt = await cap.waitFor(
      (e) => e.type === "accepted" && e.task_id === extraTask.id,
      T_EVENT,
      `accepted for ${extraTask.handle} (task_id=${extraTask.id})`,
      server
    );

    const res2 = await listTasks(server.baseUrl, ALICE.rawKey, { limit: 200 });
    expect(res2.status).toBe(200);
    const body2 = res2.body as TaskListResponse;
    expect(body2.as_of).toBeGreaterThanOrEqual(acceptedEvt.id);
    expect(body2.as_of).toBeGreaterThanOrEqual(priorAsOf);

    cap.close();
  });
});
