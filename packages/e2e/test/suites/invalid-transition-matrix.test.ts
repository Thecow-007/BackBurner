import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ALICE,
  BOB,
  EventCapture,
  T_EVENT,
  T_JOB,
  cancel,
  collect,
  getTask,
  resetDatabase,
  retry,
  settle,
  spawnServer,
  stopServer,
  submit,
  type ErrorEnvelope,
  type ServerHandle,
  type TaskObject,
} from "../../src/index.js";

/**
 * Supplemental suite 5.2 — invalid-transition matrix (test-plan.md §5.2;
 * api-contract.md §6.4-§6.6). Drives one task into each of the five statuses
 * — plus the collected/uncollected split on the two terminal ones — then
 * attempts every operator action (`cancel`, `retry`, `collect` via
 * `GET .../result`) against it. Every illegal move is a `409 invalid_state`
 * echoing the task's actual `current_status`; every legal move is a `200`
 * followed by a wait for the event it causes (`cancelled`, `running` after
 * retry, `collected`).
 *
 * `WORKER_CONCURRENCY=1` for the whole file: a single long "blocker" job
 * saturates the pool so a second submission provably stays `queued` instead
 * of racing into `running`.
 *
 * ── Canonical supplemental-suite lifecycle (test-plan.md §3.1-§3.2) ──
 * One server per FILE; `settle()` drains both actors before each truncation
 * even though this suite only acts as `e2e-alice`, matching every other
 * supplemental suite's shape.
 */
describe("invalid-transition-matrix", () => {
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

  // ── state factories (test-plan.md §5.2) ─────────────────────────────

  /** A long-lived job that saturates the sole worker slot for the rest of
   * the test — the mechanism that keeps a second submission `queued`. */
  async function buildBlocker(cap: EventCapture): Promise<TaskObject> {
    const res = await submit(server.baseUrl, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: 30000 },
    });
    expect(res.status).toBe(201);
    const task = res.body as TaskObject;
    await cap.waitFor(
      (e) => e.type === "running" && e.task_id === task.id,
      T_EVENT,
      `blocker running (task_id=${task.id})`,
      server
    );
    return task;
  }

  /** Submitted while the blocker holds the only slot — stays `queued` for
   * as long as the blocker runs (30s), confirmed via a follow-up `GET`. */
  async function buildQueuedTarget(): Promise<TaskObject> {
    const res = await submit(server.baseUrl, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: 30000 },
    });
    expect(res.status).toBe(201);
    const task = res.body as TaskObject;
    const got = await getTask(server.baseUrl, ALICE.rawKey, task.handle);
    expect(got.status).toBe(200);
    expect((got.body as TaskObject).status).toBe("queued");
    return task;
  }

  /** Dispatched straight to `running` — no blocker needed, since the pool
   * starts idle at the top of every test. */
  async function buildRunningTask(cap: EventCapture): Promise<TaskObject> {
    const res = await submit(server.baseUrl, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: 30000 },
    });
    expect(res.status).toBe(201);
    const task = res.body as TaskObject;
    await cap.waitFor(
      (e) => e.type === "running" && e.task_id === task.id,
      T_EVENT,
      `running (task_id=${task.id})`,
      server
    );
    return task;
  }

  /** A short job driven to `ready`, uncollected. */
  async function buildReadyTask(cap: EventCapture): Promise<TaskObject> {
    const res = await submit(server.baseUrl, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: 500 },
    });
    expect(res.status).toBe(201);
    const task = res.body as TaskObject;
    await cap.waitFor(
      (e) => e.type === "ready" && e.task_id === task.id,
      T_JOB(500),
      `ready (task_id=${task.id})`,
      server
    );
    return task;
  }

  /** `ready`, then collected once. */
  async function buildReadyCollectedTask(
    cap: EventCapture
  ): Promise<{ task: TaskObject; firstCollect: TaskObject }> {
    const task = await buildReadyTask(cap);
    const res = await collect(server.baseUrl, ALICE.rawKey, task.handle);
    expect(res.status).toBe(200);
    const firstCollect = res.body as TaskObject;
    expect(firstCollect.collected).toBe(true);
    await cap.waitFor(
      (e) => e.type === "collected" && e.task_id === task.id,
      T_EVENT,
      `collected (task_id=${task.id})`,
      server
    );
    return { task, firstCollect };
  }

  /** A single fast, single-attempt failure: `max_attempts: 1` skips the
   * retry-with-backoff chain entirely and lands straight in `failed`. */
  async function buildFailedTask(cap: EventCapture): Promise<TaskObject> {
    const res = await submit(server.baseUrl, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: 300, fail: true },
      max_attempts: 1,
    });
    expect(res.status).toBe(201);
    const task = res.body as TaskObject;
    await cap.waitFor(
      (e) => e.type === "failed" && e.task_id === task.id,
      T_JOB(300),
      `failed (task_id=${task.id})`,
      server
    );
    return task;
  }

  /** `failed`, then collected once. */
  async function buildFailedCollectedTask(
    cap: EventCapture
  ): Promise<{ task: TaskObject; firstCollect: TaskObject }> {
    const task = await buildFailedTask(cap);
    const res = await collect(server.baseUrl, ALICE.rawKey, task.handle);
    expect(res.status).toBe(200);
    const firstCollect = res.body as TaskObject;
    expect(firstCollect.collected).toBe(true);
    await cap.waitFor(
      (e) => e.type === "collected" && e.task_id === task.id,
      T_EVENT,
      `collected (task_id=${task.id})`,
      server
    );
    return { task, firstCollect };
  }

  /** Cancelled while still `queued` (behind a blocker) — distinct from
   * cancelling a `running` task, which the `running` row already covers.
   * Requires a blocker already saturating the pool (call `buildBlocker`
   * first). */
  async function buildCancelledTask(cap: EventCapture): Promise<TaskObject> {
    const target = await buildQueuedTarget();
    const res = await cancel(server.baseUrl, ALICE.rawKey, target.handle);
    expect(res.status).toBe(200);
    expect((res.body as TaskObject).status).toBe("cancelled");
    await cap.waitFor(
      (e) => e.type === "cancelled" && e.task_id === target.id,
      T_EVENT,
      `cancelled (task_id=${target.id})`,
      server
    );
    return target;
  }

  /** Asserts the standard illegal-transition envelope: `409 invalid_state`
   * with `current_status` echoing the task's actual status. */
  function expectInvalidState(
    res: { status: number; body: unknown },
    currentStatus: string,
    label: string
  ): void {
    expect(res.status, label).toBe(409);
    const body = res.body as ErrorEnvelope;
    expect(body.error.code, label).toBe("invalid_state");
    expect(body.error.current_status, label).toBe(currentStatus);
  }

  // ── the matrix — one `it()` per FROM-state row ──────────────────────

  it("queued: retry and collect are rejected; cancel succeeds", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;

    await buildBlocker(cap);
    const target = await buildQueuedTarget();

    // Non-mutating checks first — the mutating `cancel` goes last so it
    // doesn't disturb the `queued` precondition the other two rely on.
    expectInvalidState(
      await retry(server.baseUrl, ALICE.rawKey, target.handle),
      "queued",
      "retry from queued"
    );
    expectInvalidState(
      await collect(server.baseUrl, ALICE.rawKey, target.handle),
      "queued",
      "collect from queued"
    );

    const cancelRes = await cancel(server.baseUrl, ALICE.rawKey, target.handle);
    expect(cancelRes.status).toBe(200);
    expect((cancelRes.body as TaskObject).status).toBe("cancelled");
    await cap.waitFor(
      (e) => e.type === "cancelled" && e.task_id === target.id,
      T_EVENT,
      `cancelled after cancel from queued (task_id=${target.id})`,
      server
    );

    cap.close();
  });

  it("running: retry and collect are rejected; cancel succeeds", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;

    const task = await buildRunningTask(cap);

    // Same reasoning as the `queued` row: mutating `cancel` goes last.
    expectInvalidState(
      await retry(server.baseUrl, ALICE.rawKey, task.handle),
      "running",
      "retry from running"
    );
    expectInvalidState(
      await collect(server.baseUrl, ALICE.rawKey, task.handle),
      "running",
      "collect from running"
    );

    const cancelRes = await cancel(server.baseUrl, ALICE.rawKey, task.handle);
    expect(cancelRes.status).toBe(200);
    expect((cancelRes.body as TaskObject).status).toBe("cancelled");
    await cap.waitFor(
      (e) => e.type === "cancelled" && e.task_id === task.id,
      T_EVENT,
      `cancelled after cancel from running (task_id=${task.id})`,
      server
    );

    cap.close();
  });

  it("ready (uncollected): cancel and retry are rejected; collect succeeds", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;

    // Separate fresh `ready` tasks per action (test-plan.md §5.2): `collect`
    // mutates, so `cancel`/`retry` are checked against instances it never
    // touched, rather than chaining off one another.
    const forCancel = await buildReadyTask(cap);
    expectInvalidState(
      await cancel(server.baseUrl, ALICE.rawKey, forCancel.handle),
      "ready",
      "cancel from ready (uncollected)"
    );

    const forRetry = await buildReadyTask(cap);
    expectInvalidState(
      await retry(server.baseUrl, ALICE.rawKey, forRetry.handle),
      "ready",
      "retry from ready (uncollected)"
    );

    const forCollect = await buildReadyTask(cap);
    const collectRes = await collect(server.baseUrl, ALICE.rawKey, forCollect.handle);
    expect(collectRes.status).toBe(200);
    const collected = collectRes.body as TaskObject;
    expect(collected.status).toBe("ready");
    expect(collected.collected).toBe(true);
    expect(collected.result).not.toBeNull();
    expect(collected.error).toBeNull();
    await cap.waitFor(
      (e) => e.type === "collected" && e.task_id === forCollect.id,
      T_EVENT,
      `collected from ready (task_id=${forCollect.id})`,
      server
    );

    cap.close();
  });

  it("ready (collected): cancel and retry are rejected; collect is idempotent", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;

    // None of the three actions mutate a `ready`+collected task further
    // (cancel/retry are always rejected; a second collect is a no-op), so
    // one instance safely serves all three checks.
    const { task, firstCollect } = await buildReadyCollectedTask(cap);

    expectInvalidState(
      await cancel(server.baseUrl, ALICE.rawKey, task.handle),
      "ready",
      "cancel from ready (collected)"
    );
    expectInvalidState(
      await retry(server.baseUrl, ALICE.rawKey, task.handle),
      "ready",
      "retry from ready (collected)"
    );

    const secondCollect = await collect(server.baseUrl, ALICE.rawKey, task.handle);
    expect(secondCollect.status).toBe(200);
    const body = secondCollect.body as TaskObject;
    expect(body.status).toBe("ready");
    expect(body.collected).toBe(true);
    expect(body.result).toEqual(firstCollect.result);

    cap.close();
  });

  it("failed (uncollected): cancel is rejected; retry re-queues; collect succeeds", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;

    // Separate fresh `failed` tasks per action: both `retry` and `collect`
    // mutate, so no two actions can share one instance. `retry` goes last —
    // it re-dispatches the task in the background (it will run and fail
    // again under the same params), which would otherwise contend for the
    // sole worker slot against the next factory's own build.
    const forCancel = await buildFailedTask(cap);
    expectInvalidState(
      await cancel(server.baseUrl, ALICE.rawKey, forCancel.handle),
      "failed",
      "cancel from failed (uncollected)"
    );

    const forCollect = await buildFailedTask(cap);
    const collectRes = await collect(server.baseUrl, ALICE.rawKey, forCollect.handle);
    expect(collectRes.status).toBe(200);
    const collected = collectRes.body as TaskObject;
    expect(collected.status).toBe("failed");
    expect(collected.collected).toBe(true);
    expect(collected.result).toBeNull();
    expect(collected.error).not.toBeNull();
    await cap.waitFor(
      (e) => e.type === "collected" && e.task_id === forCollect.id,
      T_EVENT,
      `collected from failed (task_id=${forCollect.id})`,
      server
    );

    const forRetry = await buildFailedTask(cap);
    const retryRes = await retry(server.baseUrl, ALICE.rawKey, forRetry.handle);
    expect(retryRes.status).toBe(200);
    const retried = retryRes.body as TaskObject;
    expect(retried.status).toBe("queued");
    expect(retried.attempts).toBe(0);
    await cap.waitFor(
      (e) => e.type === "running" && e.task_id === forRetry.id,
      T_EVENT,
      `running after retry from failed (task_id=${forRetry.id})`,
      server
    );

    cap.close();
  });

  it("failed (collected): cancel and retry are rejected (permanently); collect is idempotent", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;

    // As with `ready` (collected): nothing here mutates further, so one
    // instance safely serves all three checks. This is the row that proves
    // collection permanently retires retry — 409, not the 200 a freshly
    // failed, still-uncollected task would get.
    const { task, firstCollect } = await buildFailedCollectedTask(cap);

    expectInvalidState(
      await cancel(server.baseUrl, ALICE.rawKey, task.handle),
      "failed",
      "cancel from failed (collected)"
    );
    expectInvalidState(
      await retry(server.baseUrl, ALICE.rawKey, task.handle),
      "failed",
      "retry from failed (collected)"
    );

    const secondCollect = await collect(server.baseUrl, ALICE.rawKey, task.handle);
    expect(secondCollect.status).toBe(200);
    const body = secondCollect.body as TaskObject;
    expect(body.status).toBe("failed");
    expect(body.collected).toBe(true);
    expect(body.error).toEqual(firstCollect.error);

    cap.close();
  });

  it("cancelled: cancel, retry, and collect are all rejected", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;

    await buildBlocker(cap);
    const task = await buildCancelledTask(cap);

    // None of the three remaining attempts mutate a terminal `cancelled`
    // task, so one instance safely serves all three checks.
    expectInvalidState(
      await cancel(server.baseUrl, ALICE.rawKey, task.handle),
      "cancelled",
      "cancel from cancelled"
    );
    expectInvalidState(
      await retry(server.baseUrl, ALICE.rawKey, task.handle),
      "cancelled",
      "retry from cancelled"
    );
    expectInvalidState(
      await collect(server.baseUrl, ALICE.rawKey, task.handle),
      "cancelled",
      "collect from cancelled"
    );

    cap.close();
  });
});
