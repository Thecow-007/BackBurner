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
  settle,
  spawnServer,
  stopServer,
  submit,
  type ListQuery,
  type ServerHandle,
  type TaskCounts,
  type TaskListResponse,
  type TaskObject,
  type TaskStatus,
} from "../../src/index.js";

/**
 * Supplemental suite 5.11 — task-counts coherence (test-plan.md §5.11;
 * api-contract.md §6.2's `counts` object; build-plan.md "Task counts").
 *
 * The rule under test is an honesty rule: **a count must always match the
 * list it opens.** Every assertion here pairs a number with the rows that
 * number claims to describe, under each filter combination — no filter,
 * `status` alone, `lane` alone, `status`+`lane`, and a `from`/`to` window.
 * The subtlety is that the six fields do NOT share one filter basis:
 *
 * | Field         | Respects            | Ignores      |
 * |---------------|---------------------|--------------|
 * | `all`         | from, to            | status, lane |
 * | `matching`    | every active filter | nothing      |
 * | `uncollected` | lane, from, to      | status       |
 * | `status.*`    | lane, from, to      | status       |
 * | `lane.*`      | status, from, to    | lane         |
 * | `lanes`       | nothing — engine lane REGISTRATION, not data |
 *
 * ── Canonical supplemental-suite lifecycle (test-plan.md §3.1-§3.2) ──
 * One server per FILE (spawned in `beforeAll`, stopped in `afterAll`).
 * Between tests, `settle()` cancels every `queued`/`running` task through the
 * API so the worker pool is provably idle, and only THEN is the database
 * truncated. `settle()` needs a live per-user `EventCapture` to await the
 * `cancelled` events it triggers.
 *
 * ── Corpus (12 tasks, built fresh per test) ──
 * Spawned with `WORKER_CONCURRENCY: "1"` exactly as the filters-pagination
 * suite is, and for the same reason: a single long "blocker" task holds the
 * lone worker slot so the tasks submitted behind it sit provably `queued`,
 * which pins every status total for the duration of the test.
 */
describe("counts-coherence", () => {
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
    for (const user of [ALICE, BOB]) {
      const cap = new EventCapture(server.baseUrl, user.rawKey, { server });
      await cap.ready;
      await settle(server.baseUrl, user.rawKey, cap, { server });
      cap.close();
    }
  });

  // ── Corpus construction ──────────────────────────────────────────────

  /** Short enough that ready/failed corpus tasks finish quickly on the lone
   * worker, long enough to be a real, observable run. */
  const SHORT_MS = 300;
  /** Long enough that cancel() always lands on a still queued-or-running
   * task, never a race against natural completion. */
  const CANCEL_MS = 5000;
  /** Tasks parked behind the blocker never run; the value is immaterial. */
  const QUEUED_MS = 5000;
  /** Holds `WORKER_CONCURRENCY: "1"`'s one slot for a whole test. */
  const BLOCKER_MS = 30_000;

  const ALL_STATUSES: readonly TaskStatus[] = ["queued", "running", "ready", "failed", "cancelled"];
  const LANES = ["scrape", "report"] as const;

  /** The corpus, hand-counted. Every expectation below is derived from these
   * numbers, so a drift in construction fails loudly rather than quietly
   * agreeing with a wrong count. */
  const EXPECTED = {
    total: 12,
    status: { queued: 4, running: 1, ready: 3, failed: 2, cancelled: 2 },
    lane: { scrape: 7, report: 5 },
    /** `status IN ('ready','failed') AND NOT collected`: 3 ready − 1 collected
     * + 2 failed = 4. Per lane: scrape (2 ready − 1 collected + 1 failed) = 2,
     * report (1 ready + 1 failed) = 2. */
    uncollected: 4,
    uncollectedByLane: { scrape: 2, report: 2 },
    /** Per-lane × per-status, for the combined-filter cases. */
    byLaneStatus: {
      scrape: { queued: 2, running: 1, ready: 2, failed: 1, cancelled: 1 },
      report: { queued: 2, running: 0, ready: 1, failed: 1, cancelled: 1 },
    },
  } as const;

  interface CorpusTask {
    id: string;
    handle: string;
    lane: string;
    created_at: string;
  }

  interface Corpus {
    blocker: CorpusTask;
    all: CorpusTask[];
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
    return { id: task.id, handle: task.handle, lane: task.lane, created_at: task.created_at };
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
    // Explicit operator action, never a convenience fetch (CLAUDE.md): this
    // is the one task the `uncollected` expectations subtract.
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
    // max_attempts: 1 — the retryable failure exhausts the budget at once,
    // landing directly in `failed` with no auto-retry hop.
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
    // Terminal states first: with a single worker these must fully resolve,
    // one at a time, before the blocker claims the only slot.
    const readyScrape = await makeReady(cap, "scrape");
    const readyScrapeCollected = await makeReadyCollected(cap, "scrape");
    const readyReport = await makeReady(cap, "report");
    const failedScrape = await makeFailed(cap, "scrape");
    const failedReport = await makeFailed(cap, "report");
    const cancelledScrape = await makeCancelled(cap, "scrape");
    const cancelledReport = await makeCancelled(cap, "report");

    // The blocker now holds the lone worker slot; everything after it stays
    // `queued` for the rest of the test.
    const blocker = await makeBlocker(cap, "scrape");
    const queued = [
      await makeQueued(cap, "scrape"),
      await makeQueued(cap, "scrape"),
      await makeQueued(cap, "report"),
      await makeQueued(cap, "report"),
    ];

    const all = [
      readyScrape,
      readyScrapeCollected,
      readyReport,
      failedScrape,
      failedReport,
      cancelledScrape,
      cancelledReport,
      blocker,
      ...queued,
    ];
    expect(all.length, "corpus size").toBe(EXPECTED.total);
    return { blocker, all };
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  async function list(query: ListQuery = {}, key = ALICE.rawKey): Promise<TaskListResponse> {
    const res = await listTasks(server.baseUrl, key, { limit: 200, ...query });
    expect(res.status, `GET /tasks ${JSON.stringify(query)}`).toBe(200);
    return res.body as TaskListResponse;
  }

  function sum(counts: Record<string, number>): number {
    return Object.values(counts).reduce((a, b) => a + b, 0);
  }

  /** Structural invariants that hold on EVERY 200, regardless of filter. */
  function assertWellFormed(counts: TaskCounts, label: string): void {
    expect(counts, `${label}: counts present`).toBeDefined();
    // All five status keys, always — never omitted, zero-valued when empty.
    expect(Object.keys(counts.status).sort(), `${label}: status keys`).toEqual(
      [...ALL_STATUSES].sort()
    );
    for (const s of ALL_STATUSES) {
      expect(typeof counts.status[s], `${label}: status.${s} is a number`).toBe("number");
    }
    // One key per registered lane, and the registration list itself.
    expect(counts.lanes, `${label}: lanes`).toEqual([...LANES]);
    for (const lane of LANES) {
      expect(typeof counts.lane[lane], `${label}: lane.${lane} is a number`).toBe("number");
    }
  }

  function uncollectedIn(tasks: TaskObject[]): number {
    return tasks.filter((t) => (t.status === "ready" || t.status === "failed") && !t.collected).length;
  }

  // ── Tests ───────────────────────────────────────────────────────────

  it("no filter: every number describes the whole register and sum(status.*) === all", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    await buildCorpus(cap);

    const body = await list();
    assertWellFormed(body.counts, "unfiltered");

    // The count opens exactly the list it ships with.
    expect(body.tasks.length).toBe(EXPECTED.total);
    expect(body.counts.all).toBe(EXPECTED.total);
    expect(body.counts.matching).toBe(body.tasks.length);

    expect(body.counts.status).toEqual(EXPECTED.status);
    // The sidebar's "All" row renders this sum — it must be exact.
    expect(sum(body.counts.status)).toBe(body.counts.all);

    expect(body.counts.lane).toEqual(EXPECTED.lane);
    expect(sum(body.counts.lane)).toBe(body.counts.all);

    // `uncollected` against a hand-counted set, and against the rows.
    expect(body.counts.uncollected).toBe(EXPECTED.uncollected);
    expect(body.counts.uncollected).toBe(uncollectedIn(body.tasks));

    cap.close();
  });

  it("?status= returns exactly counts.status[thatStatus] rows, for all five values", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    await buildCorpus(cap);

    const unfiltered = (await list()).counts;

    for (const status of ALL_STATUSES) {
      const body = await list({ status });
      assertWellFormed(body.counts, status);

      // The headline promise: selecting a status shows exactly the number
      // the unfiltered view advertised for it.
      expect(body.tasks.length, `${status}: rows`).toBe(unfiltered.status[status]);
      expect(body.counts.matching, `${status}: matching`).toBe(body.tasks.length);
      expect(body.tasks.every((t) => t.status === status), `${status}: row statuses`).toBe(true);

      // `status.*` ignores the status filter — otherwise picking "ready"
      // would zero out every other row in the sidebar the moment you clicked.
      expect(body.counts.status, `${status}: status.* unchanged`).toEqual(EXPECTED.status);
      // `all` ignores status too — the register's grand total does not move.
      expect(body.counts.all, `${status}: all unchanged`).toBe(EXPECTED.total);
      // `uncollected` ignores status as well.
      expect(body.counts.uncollected, `${status}: uncollected unchanged`).toBe(EXPECTED.uncollected);

      // `lane.*` DOES respect status, and partitions the matching set.
      expect(sum(body.counts.lane), `${status}: sum(lane.*)`).toBe(body.counts.matching);
      for (const lane of LANES) {
        expect(body.counts.lane[lane], `${status}+${lane}`).toBe(EXPECTED.byLaneStatus[lane][status]);
      }
    }

    cap.close();
  });

  it("?lane= narrows status.* and uncollected, and leaves all and lane.* alone", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    await buildCorpus(cap);

    for (const lane of LANES) {
      const body = await list({ lane });
      assertWellFormed(body.counts, lane);

      expect(body.tasks.length, `${lane}: rows`).toBe(EXPECTED.lane[lane]);
      expect(body.counts.matching, `${lane}: matching`).toBe(body.tasks.length);
      expect(body.tasks.every((t) => t.lane === lane), `${lane}: row lanes`).toBe(true);

      // `all` ignores lane — the grand total is the whole register.
      expect(body.counts.all, `${lane}: all unchanged`).toBe(EXPECTED.total);
      // `lane.*` ignores the lane filter, so the sidebar's lane list keeps
      // showing every lane's total while one lane is selected.
      expect(body.counts.lane, `${lane}: lane.* unchanged`).toEqual(EXPECTED.lane);

      // `status.*` and `uncollected` DO respect lane.
      expect(body.counts.status, `${lane}: status.*`).toEqual(EXPECTED.byLaneStatus[lane]);
      expect(sum(body.counts.status), `${lane}: sum(status.*)`).toBe(body.counts.matching);
      expect(body.counts.uncollected, `${lane}: uncollected`).toBe(EXPECTED.uncollectedByLane[lane]);
      expect(body.counts.uncollected, `${lane}: uncollected vs rows`).toBe(uncollectedIn(body.tasks));
    }

    cap.close();
  });

  it("?status=&lane= together: each number keeps its own basis", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    await buildCorpus(cap);

    for (const lane of LANES) {
      for (const status of ALL_STATUSES) {
        const label = `${status}+${lane}`;
        const body = await list({ status, lane });
        assertWellFormed(body.counts, label);

        const expected = EXPECTED.byLaneStatus[lane][status];
        expect(body.tasks.length, `${label}: rows`).toBe(expected);
        expect(body.counts.matching, `${label}: matching`).toBe(expected);

        // status.* respects lane and ignores status -> the selected cell is
        // exactly `matching`, and the column still sums to the lane's total.
        expect(body.counts.status[status], `${label}: status[${status}]`).toBe(expected);
        expect(body.counts.status, `${label}: status.*`).toEqual(EXPECTED.byLaneStatus[lane]);
        // lane.* respects status and ignores lane -> the selected cell is
        // again exactly `matching`, from the other direction.
        expect(body.counts.lane[lane], `${label}: lane[${lane}]`).toBe(expected);
        // all respects neither.
        expect(body.counts.all, `${label}: all`).toBe(EXPECTED.total);
      }
    }

    cap.close();
  });

  it("?from=/?to= scope every number; complementary windows partition the register", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    const corpus = await buildCorpus(cap);

    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const hourAhead = new Date(Date.now() + 3600_000).toISOString();

    // A bracket around the whole corpus changes nothing.
    const bracket = await list({ from: hourAgo, to: hourAhead });
    assertWellFormed(bracket.counts, "bracket");
    expect(bracket.counts.all).toBe(EXPECTED.total);
    expect(bracket.counts.matching).toBe(bracket.tasks.length);
    expect(bracket.counts.status).toEqual(EXPECTED.status);
    expect(bracket.counts.lane).toEqual(EXPECTED.lane);
    expect(bracket.counts.uncollected).toBe(EXPECTED.uncollected);

    // An empty window zeroes every number — but still carries all five
    // status keys and both registered lanes, and still knows the lanes.
    const empty = await list({ to: hourAgo });
    assertWellFormed(empty.counts, "empty window");
    expect(empty.tasks).toEqual([]);
    expect(empty.counts.all).toBe(0);
    expect(empty.counts.matching).toBe(0);
    expect(empty.counts.uncollected).toBe(0);
    expect(empty.counts.status).toEqual({ queued: 0, running: 0, ready: 0, failed: 0, cancelled: 0 });
    expect(empty.counts.lane).toEqual({ scrape: 0, report: 0 });

    // Half-open `[from, to)` on a boundary taken from real data: the two
    // complementary windows are disjoint and cover the register exactly.
    const boundary = corpus.blocker.created_at;
    const before = await list({ to: boundary });
    const after = await list({ from: boundary });
    assertWellFormed(before.counts, "before boundary");
    assertWellFormed(after.counts, "after boundary");

    expect(before.counts.all, "before: count vs rows").toBe(before.tasks.length);
    expect(after.counts.all, "after: count vs rows").toBe(after.tasks.length);
    expect(before.counts.all + after.counts.all, "windows partition the register").toBe(
      EXPECTED.total
    );
    expect(before.counts.all, "before window is non-trivial").toBeGreaterThan(0);
    expect(after.counts.all, "after window is non-trivial").toBeGreaterThan(0);

    // Inside a window every basis still holds.
    for (const [label, body] of [
      ["before", before],
      ["after", after],
    ] as const) {
      expect(sum(body.counts.status), `${label}: sum(status.*) === all`).toBe(body.counts.all);
      expect(sum(body.counts.lane), `${label}: sum(lane.*) === all`).toBe(body.counts.all);
      expect(body.counts.matching, `${label}: matching`).toBe(body.counts.all);
      expect(body.counts.uncollected, `${label}: uncollected vs rows`).toBe(
        uncollectedIn(body.tasks)
      );
    }

    // A window combined with a status filter: rows still equal the number
    // the window's own status breakdown advertises.
    for (const status of ALL_STATUSES) {
      const windowed = await list({ to: boundary, status });
      expect(windowed.tasks.length, `before+${status}`).toBe(before.counts.status[status]);
      expect(windowed.counts.matching, `before+${status}: matching`).toBe(windowed.tasks.length);
      expect(windowed.counts.all, `before+${status}: all`).toBe(before.counts.all);
    }

    cap.close();
  });

  it("counts ride on every cursor page and do not vary page to page", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    await buildCorpus(cap);

    let cursor: string | undefined;
    let page = 0;
    let seen = 0;
    let first: TaskCounts | undefined;

    for (;;) {
      page += 1;
      expect(page, "cursor chain did not terminate").toBeLessThanOrEqual(10);

      const body = await list({ limit: 5, cursor });
      assertWellFormed(body.counts, `page ${page}`);
      first ??= body.counts;

      // Never omitted on a page, never a page-local tally: `matching` is the
      // whole matching set, which is what "10 of N" counts against.
      expect(body.counts.matching, `page ${page}: matching`).toBe(EXPECTED.total);
      expect(body.counts, `page ${page}: identical to page 1`).toEqual(first);

      seen += body.tasks.length;
      if (body.next_cursor === null) break;
      cursor = body.next_cursor;
    }

    expect(seen, "rows walked === matching").toBe(first?.matching);

    cap.close();
  });

  it("a user with zero tasks still gets the registered lanes and an all-zero counts object", async () => {
    // ALICE has a task; BOB has none. Counts are per-user like every other
    // read, and `lanes` comes from engine REGISTRATION, not from the data —
    // so BOB's submit-form lane picker still has both lanes to offer.
    const alice = await submitTask("scrape", { duration_ms: QUEUED_MS });
    expect(alice.handle).toBe("scrape-1");

    const body = await list({}, BOB.rawKey);
    assertWellFormed(body.counts, "bob");
    expect(body.tasks).toEqual([]);
    expect(body.counts.all).toBe(0);
    expect(body.counts.matching).toBe(0);
    expect(body.counts.uncollected).toBe(0);
    expect(body.counts.status).toEqual({ queued: 0, running: 0, ready: 0, failed: 0, cancelled: 0 });
    expect(body.counts.lane).toEqual({ scrape: 0, report: 0 });
    expect(body.counts.lanes).toEqual([...LANES]);

    // ALICE's own register is unaffected by BOB's empty one.
    const mine = await list();
    expect(mine.counts.all).toBe(1);
    expect(mine.counts.lanes).toEqual([...LANES]);
  });
});
