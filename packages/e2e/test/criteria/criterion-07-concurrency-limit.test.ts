import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ALICE,
  EventCapture,
  listTasks,
  resetDatabase,
  spawnServer,
  stopServer,
  submit,
  T_EVENT,
  T_SETTLE,
  T_WAVES,
  type CapturedEvent,
  type ServerHandle,
  type TaskListResponse,
  type TaskObject,
} from "../../src/index.js";

/**
 * criterion-07-concurrency-limit (test-plan.md §4.7).
 *
 * Spec: "Concurrency respected. With concurrency set to 2, submit 5 jobs at
 * once. At no moment are more than 2 in `running`; the rest stay `queued`
 * and start only as slots free up."
 */
describe("criterion-07-concurrency-limit", () => {
  let server: ServerHandle | undefined;
  let events: EventCapture | undefined;

  beforeEach(async () => {
    await resetDatabase();
    server = await spawnServer({ WORKER_CONCURRENCY: "2" });
  });

  afterEach(async () => {
    if (events) events.close();
    if (server) await stopServer(server);
  });

  it("never runs more than 2 of 5 concurrently submitted jobs at once", async () => {
    const s = server;
    if (!s) throw new Error("server was not spawned");

    // ES connected before the first submit (test-plan.md §4 intro).
    events = new EventCapture(s.baseUrl, ALICE.rawKey, { server: s });
    // Wait for the stream to be open before the first submit, so no event
    // can be missed (test-plan.md §4 intro: "ES" means connected first).
    await events.ready;
    const ec = events;

    // Step 1: submit 5 scrape jobs, duration_ms: 2000 each, concurrently.
    const [r1, r2, r3, r4, r5] = await Promise.all([
      submit(s.baseUrl, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 2000 } }),
      submit(s.baseUrl, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 2000 } }),
      submit(s.baseUrl, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 2000 } }),
      submit(s.baseUrl, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 2000 } }),
      submit(s.baseUrl, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 2000 } }),
    ]);
    const submissions = [r1, r2, r3, r4, r5];

    for (const r of submissions) {
      expect(r.status).toBe(201);
      expect((r.body as TaskObject).status).toBe("queued");
    }

    const bodies = submissions.map((r) => r.body as TaskObject);
    const taskIds = new Set(bodies.map((b) => b.id));
    const handles = bodies.map((b) => b.handle);

    // All five 201s returned status: queued (checked above), and the *set*
    // of handles is exactly {scrape-1 … scrape-5} — set equality, no
    // positional mapping to Promise.all order (test-plan.md §4.7, §3.6 rule 5).
    expect(new Set(handles)).toEqual(
      new Set(["scrape-1", "scrape-2", "scrape-3", "scrape-4", "scrape-5"])
    );
    expect(taskIds.size).toBe(5);

    // Step 2: wait for all 5 ready (3 waves of 2s), then keep capturing
    // T_SETTLE more — combined here with the "zero failed/cancelled"
    // negative assertion via assertNever, whose sentinel is the 5th ready
    // event (test-plan.md §3.6 rule 3).
    const readyEvents = await ec.waitForCount(
      (e) => e.type === "ready" && taskIds.has(e.task_id),
      5,
      T_WAVES(3, 2000),
      s
    );
    if (readyEvents.length !== 5) {
      throw new Error(`expected exactly 5 ready events, got ${readyEvents.length}`);
    }
    const fifthReady = readyEvents[4];
    if (!fifthReady) throw new Error("missing 5th ready event");

    const forbidden = (e: CapturedEvent): boolean =>
      (e.type === "failed" || e.type === "cancelled") && taskIds.has(e.task_id);
    await ec.assertNever(forbidden, {
      sentinel: (e) => e.id === fifthReady.id,
      sentinelTimeoutMs: T_EVENT,
      settleMs: T_SETTLE,
      server: s,
    });

    // Step 3: reconstruct the running-count timeline — sort all events for
    // these 5 task_ids by SSE id; running ⇒ +1, ready/failed/cancelled ⇒ −1;
    // compute the running count after every prefix.
    const relevant = ec
      .all()
      .filter((e) => taskIds.has(e.task_id))
      .slice()
      .sort((a, b) => a.id - b.id);

    let runningCount = 0;
    let maxRunning = 0;
    for (const e of relevant) {
      if (e.type === "running") runningCount += 1;
      else if (e.type === "ready" || e.type === "failed" || e.type === "cancelled") {
        runningCount -= 1;
      }
      maxRunning = Math.max(maxRunning, runningCount);
    }

    // The prefix-sum timeline never exceeds 2 at any point.
    expect(maxRunning).toBeLessThanOrEqual(2);

    // Exactly 5 running and 5 ready events; zero failed/cancelled.
    const runningEvents = relevant.filter((e) => e.type === "running");
    const finalReadyEvents = relevant.filter((e) => e.type === "ready");
    const failedOrCancelled = relevant.filter(
      (e) => e.type === "failed" || e.type === "cancelled"
    );
    expect(runningEvents).toHaveLength(5);
    expect(finalReadyEvents).toHaveLength(5);
    expect(failedOrCancelled).toHaveLength(0);

    // The 3rd running event has a larger SSE id than the 1st ready event —
    // slots are granted only as they free up, never eagerly.
    const thirdRunning = runningEvents[2];
    const firstReady = finalReadyEvents[0];
    if (!thirdRunning || !firstReady) {
      throw new Error("expected at least 3 running events and 1 ready event");
    }
    expect(thirdRunning.id).toBeGreaterThan(firstReady.id);

    // Final GET /tasks: all 5 ready.
    const listRes = await listTasks(s.baseUrl, ALICE.rawKey);
    expect(listRes.status).toBe(200);
    const list = listRes.body as TaskListResponse;
    expect(list.tasks).toHaveLength(5);
    for (const t of list.tasks) {
      expect(t.status).toBe("ready");
    }
  });
});
