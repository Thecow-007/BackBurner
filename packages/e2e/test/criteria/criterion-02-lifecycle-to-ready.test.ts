import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ALICE,
  collect,
  EventCapture,
  getTask,
  resetDatabase,
  spawnServer,
  stopServer,
  submit,
  T_EVENT,
  T_JOB,
  T_SETTLE,
  type CapturedEvent,
  type ServerHandle,
  type TaskObject,
} from "../../src/index.js";

/**
 * criterion-02-lifecycle-to-ready (test-plan.md §4.2).
 *
 * Spec: "Lifecycle to ready. For that same `scrape-1`: it shows `running`
 * within about a second, then `ready` after about 10s. `GET
 * /tasks/scrape-1/result` returns the result and flips `collected` to true.
 * The `/events` stream carried an `accepted` then a `ready` event for
 * `scrape-1`."
 */
/** Pinned job duration for this criterion (test-plan.md §4.2 step 1). Every
 * derived timing bound below is computed from this one named value rather
 * than repeating a bare literal. */
const DURATION_MS = 10_000;

describe("criterion-02-lifecycle-to-ready", () => {
  let server: ServerHandle | undefined;
  let events: EventCapture | undefined;

  beforeEach(async () => {
    await resetDatabase();
    server = await spawnServer();
  });

  afterEach(async () => {
    if (events) events.close();
    if (server) await stopServer(server);
  });

  it("goes accepted -> running -> ready, and collect() flips collected", async () => {
    const s = server;
    if (!s) throw new Error("server was not spawned");

    // ES connected before the first submit (test-plan.md §4 intro).
    events = new EventCapture(s.baseUrl, ALICE.rawKey, { server: s });
    // Wait for the stream to be open before the first submit, so no event
    // can be missed (test-plan.md §4 intro: "ES" means connected first).
    await events.ready;
    const ec = events;

    // Step 1: submit, record task_id.
    const submitRes = await submit(s.baseUrl, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: DURATION_MS },
    });
    expect(submitRes.status).toBe(201);
    const submitted = submitRes.body as TaskObject;
    const taskId = submitted.id;

    // Step 2: accepted event.
    const accepted = await ec.waitFor(
      (e) => e.type === "accepted" && e.task_id === taskId,
      T_EVENT,
      `accepted for task_id=${taskId}`,
      s
    );

    // Step 3: running event; record arrival time; GET shows running.
    const running = await ec.waitFor(
      (e) => e.type === "running" && e.task_id === taskId,
      T_EVENT,
      `running for task_id=${taskId}`,
      s
    );
    const tRun = Date.now();

    const midGet = await getTask(s.baseUrl, ALICE.rawKey, "scrape-1");
    expect(midGet.status).toBe(200);
    expect((midGet.body as TaskObject).status).toBe("running");

    // Step 4: ready event; record arrival time.
    const ready = await ec.waitFor(
      (e) => e.type === "ready" && e.task_id === taskId,
      T_JOB(DURATION_MS),
      `ready for task_id=${taskId}`,
      s
    );
    const tReady = Date.now();

    // Step 5: collect the result.
    const collectRes = await collect(s.baseUrl, ALICE.rawKey, "scrape-1");

    // --- Assertions ---

    // Event order by SSE id.
    expect(accepted.id).toBeLessThan(running.id);
    expect(running.id).toBeLessThan(ready.id);

    // accepted and ready carry the spec shape.
    expect(accepted.type).toBe("accepted");
    expect(accepted.handle).toBe("scrape-1");
    expect(accepted.lane).toBe("scrape");
    expect(typeof accepted.summary).toBe("string");

    expect(ready.type).toBe("ready");
    expect(ready.handle).toBe("scrape-1");
    expect(ready.lane).toBe("scrape");
    expect(typeof ready.summary).toBe("string");

    // ~10s of work actually happened (10% tolerance on the lower bound,
    // test-plan.md §3.6 rule 2), bounded above by T_JOB(DURATION_MS).
    expect(tReady - tRun).toBeGreaterThanOrEqual(DURATION_MS * 0.9);
    expect(tReady - tRun).toBeLessThanOrEqual(T_JOB(DURATION_MS));

    // Step 5 assertions: full task object, collected, result shape.
    expect(collectRes.status).toBe(200);
    const collected = collectRes.body as TaskObject;
    expect(collected.status).toBe("ready");
    expect(collected.collected).toBe(true);
    expect(collected.error).toBeNull();
    expect(collected.result).not.toBeNull();
    const result = collected.result as { message: unknown; slept_ms: unknown };
    expect(typeof result.message).toBe("string");
    expect(typeof result.slept_ms).toBe("number");

    // MUST NOT arrive (whole test): any failed or cancelled event for
    // task_id — asserted with assertNever against the ready event as
    // sentinel (already buffered, so the sentinel wait resolves immediately)
    // plus the standard settle tail.
    const forbidden = (e: CapturedEvent): boolean =>
      (e.type === "failed" || e.type === "cancelled") && e.task_id === taskId;
    await ec.assertNever(forbidden, {
      sentinel: (e) => e.type === "ready" && e.task_id === taskId,
      sentinelTimeoutMs: T_EVENT,
      settleMs: T_SETTLE,
      server: s,
    });
  });
});
