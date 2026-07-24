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
  T_COMPLETION_SPAN,
  T_JOB,
  T_SETTLE,
  type CapturedEvent,
  type ServerHandle,
  type TaskListResponse,
  type TaskObject,
} from "../../src/index.js";

/**
 * criterion-08-concurrent-completions (test-plan.md §4.8).
 *
 * Spec: "Concurrent completions. Submit 3 jobs that all finish within about a
 * second of each other. All 3 reach `ready`, all 3 `ready` events arrive on
 * the stream, and no state is lost, duplicated, or left stuck in `running`."
 */
describe("criterion-08-concurrent-completions", () => {
  let server: ServerHandle | undefined;
  let events: EventCapture | undefined;

  beforeEach(async () => {
    await resetDatabase();
    server = await spawnServer({ WORKER_CONCURRENCY: "4" });
  });

  afterEach(async () => {
    if (events) events.close();
    if (server) await stopServer(server);
  });

  it("lands all 3 simultaneously-finishing jobs in ready with no loss or duplication", async () => {
    const s = server;
    if (!s) throw new Error("server was not spawned");

    // ES connected before the first submit (test-plan.md §4 intro).
    events = new EventCapture(s.baseUrl, ALICE.rawKey, { server: s });
    // Wait for the stream to be open before the first submit, so no event
    // can be missed (test-plan.md §4 intro: "ES" means connected first).
    await events.ready;
    const ec = events;

    // Step 1: submit 3 scrape jobs, duration_ms: 3000 each, concurrently —
    // identical durations and simultaneous starts make them complete within
    // ~1s of each other (WORKER_CONCURRENCY=4 lets all three run at once).
    const [r1, r2, r3] = await Promise.all([
      submit(s.baseUrl, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 3000 } }),
      submit(s.baseUrl, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 3000 } }),
      submit(s.baseUrl, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 3000 } }),
    ]);
    const submissions = [r1, r2, r3];

    for (const r of submissions) {
      expect(r.status).toBe(201);
    }
    const bodies = submissions.map((r) => r.body as TaskObject);
    const taskIds = new Set(bodies.map((b) => b.id));
    expect(taskIds.size).toBe(3);

    // Step 2: wait for all 3 ready; keep capturing T_SETTLE more — combined
    // here with the "MUST NOT arrive: any failed or cancelled event"
    // negative assertion via assertNever, whose sentinel is the 3rd ready
    // event (test-plan.md §3.6 rule 3).
    const readyEvents = await ec.waitForCount(
      (e) => e.type === "ready" && taskIds.has(e.task_id),
      3,
      T_JOB(3000),
      s
    );
    if (readyEvents.length !== 3) {
      throw new Error(`expected exactly 3 ready events, got ${readyEvents.length}`);
    }

    // Premise check: the three ready arrival times (server-committed `at`)
    // span < 2000ms — the scenario the spec describes was actually exercised.
    const times = readyEvents.map((e) => Date.parse(e.at));
    const span = Math.max(...times) - Math.min(...times);
    expect(span).toBeLessThan(T_COMPLETION_SPAN);

    const thirdReady = readyEvents[2];
    if (!thirdReady) throw new Error("missing 3rd ready event");

    const forbidden = (e: CapturedEvent): boolean =>
      (e.type === "failed" || e.type === "cancelled") && taskIds.has(e.task_id);
    await ec.assertNever(forbidden, {
      sentinel: (e) => e.id === thirdReady.id,
      sentinelTimeoutMs: T_EVENT,
      settleMs: T_SETTLE,
      server: s,
    });

    // Exactly 3 ready events with 3 distinct task_ids — no duplicates: no
    // task_id appears in more than one ready event, including during the
    // settle window (judged against the final buffer, post-settle).
    const finalReady = ec.all().filter((e) => e.type === "ready" && taskIds.has(e.task_id));
    expect(finalReady).toHaveLength(3);
    const finalReadyTaskIds = new Set(finalReady.map((e) => e.task_id));
    expect(finalReadyTaskIds.size).toBe(3);

    // Each ready event's SSE id is unique and strictly increasing in arrival
    // order (buffer order = arrival order).
    const ids = finalReady.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i += 1) {
      const prev = ids[i - 1];
      const curr = ids[i];
      if (prev === undefined || curr === undefined) {
        throw new Error("unexpected hole in ready event id sequence");
      }
      expect(curr).toBeGreaterThan(prev);
    }

    // Step 3: all 3 tasks ready; zero tasks running or queued — nothing
    // lost, nothing stuck.
    const listRes = await listTasks(s.baseUrl, ALICE.rawKey);
    expect(listRes.status).toBe(200);
    const list = listRes.body as TaskListResponse;
    expect(list.tasks).toHaveLength(3);
    for (const t of list.tasks) {
      expect(t.status).toBe("ready");
    }
    expect(list.tasks.filter((t) => t.status === "running" || t.status === "queued")).toHaveLength(
      0
    );
  });
});
