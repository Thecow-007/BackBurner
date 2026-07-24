import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ALICE,
  BOB,
  EventCapture,
  T_EVENT,
  cancel,
  resetDatabase,
  settle,
  spawnServer,
  stopServer,
  submit,
  type ServerHandle,
  type TaskObject,
} from "../../src/index.js";

/**
 * Supplemental suite 5.3 — allocator race (test-plan.md §5.3). Bursts of
 * concurrent `POST /tasks` must serialize through the handle allocator's
 * advisory lock without ever handing out a duplicate or leaving a gap, per
 * lane, and must correctly reclaim freed numbers under concurrent pressure.
 *
 * `WORKER_CONCURRENCY=2` so most of every burst stays `queued` (not
 * `running`) throughout each test — the allocator race is about the handle
 * namespace, not dispatch.
 *
 * Every assertion here is over the *set* of returned handles, never
 * positional `Promise.all` order: the advisory lock serializes allocation in
 * server arrival order, which need not match the client's array order
 * (test-plan.md §4.7, §5.3).
 *
 * ── Canonical supplemental-suite lifecycle (test-plan.md §3.1-§3.2) ──
 * One server per FILE (spawned in `beforeAll`, stopped in `afterAll`).
 * Between tests, `settle()` cancels every `queued`/`running` task through the
 * API — draining the 15s-duration jobs each scenario leaves behind — so the
 * worker pool is provably idle, and only THEN is the database truncated.
 */
describe("allocator-race", () => {
  let server: ServerHandle;

  beforeAll(async () => {
    server = await spawnServer({ WORKER_CONCURRENCY: "2" });
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

  it("assigns exactly {scrape-1..scrape-20} — no duplicates, no gaps — to a 20-way single-lane burst", async () => {
    const b = server.baseUrl;

    const submissions = await Promise.all(
      Array.from({ length: 20 }, () =>
        submit(b, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 15000 } })
      )
    );

    for (const res of submissions) {
      expect(res.status).toBe(201);
    }

    const handles = submissions.map((res) => (res.body as TaskObject).handle);
    const expected = new Set(Array.from({ length: 20 }, (_, i) => `scrape-${i + 1}`));

    // Set equality catches both duplicates (set would be smaller than the
    // array) and gaps (set would differ from the expected run).
    expect(handles).toHaveLength(20);
    expect(new Set(handles)).toEqual(expected);
    expect(new Set(handles).size).toBe(20);
  });

  it("numbers two lanes bursting concurrently 1..10 independently, with no cross-lane collision", async () => {
    const b = server.baseUrl;

    const scrapeSubmits = Array.from({ length: 10 }, () =>
      submit(b, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 15000 } })
    );
    const reportSubmits = Array.from({ length: 10 }, () =>
      submit(b, ALICE.rawKey, { lane: "report", params: { duration_ms: 15000 } })
    );

    const submissions = await Promise.all([...scrapeSubmits, ...reportSubmits]);

    for (const res of submissions) {
      expect(res.status).toBe(201);
    }

    const bodies = submissions.map((res) => res.body as TaskObject);
    const scrapeHandles = bodies.filter((t) => t.lane === "scrape").map((t) => t.handle);
    const reportHandles = bodies.filter((t) => t.lane === "report").map((t) => t.handle);

    expect(scrapeHandles).toHaveLength(10);
    expect(reportHandles).toHaveLength(10);
    expect(new Set(scrapeHandles)).toEqual(
      new Set(Array.from({ length: 10 }, (_, i) => `scrape-${i + 1}`))
    );
    expect(new Set(reportHandles)).toEqual(
      new Set(Array.from({ length: 10 }, (_, i) => `report-${i + 1}`))
    );
  });

  it("races five concurrent submits into exactly the five numbers freed by cancellation, collision-free", async () => {
    const b = server.baseUrl;

    // Rebuild the 20-wide single-lane burst for this test (beforeEach
    // truncated the previous scenario's tasks).
    const initial = await Promise.all(
      Array.from({ length: 20 }, () =>
        submit(b, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 15000 } })
      )
    );
    for (const res of initial) {
      expect(res.status).toBe(201);
    }

    const byHandle = new Map<string, TaskObject>(
      initial.map((res) => {
        const task = res.body as TaskObject;
        return [task.handle, task];
      })
    );
    expect(new Set(byHandle.keys())).toEqual(
      new Set(Array.from({ length: 20 }, (_, i) => `scrape-${i + 1}`))
    );

    // Connect the capture — and await it open — before issuing the cancels,
    // so no `cancelled` event can be missed (test-plan.md §4 intro).
    const cap = new EventCapture(b, ALICE.rawKey, { server });
    await cap.ready;

    const freedNumbers = [3, 7, 8, 15, 20];
    const targets = freedNumbers.map((n) => {
      const task = byHandle.get(`scrape-${n}`);
      if (!task) throw new Error(`missing scrape-${n} among the initial 20 submissions`);
      return task;
    });
    const targetTaskIds = new Set(targets.map((t) => t.id));

    const cancelResults = await Promise.all(
      targets.map((t) => cancel(b, ALICE.rawKey, t.handle))
    );
    for (const res of cancelResults) {
      expect(res.status).toBe(200);
    }

    // Await the 5 corresponding `cancelled` events, correlated by task_id —
    // never by handle (test-plan.md §3.6 rule 4).
    await cap.waitForCount(
      (e) => e.type === "cancelled" && targetTaskIds.has(e.task_id),
      5,
      T_EVENT,
      server
    );

    // Submit 5 new scrape jobs concurrently: their handle set must be
    // exactly the 5 freed numbers — lowest-free, collision-free allocation
    // under concurrency.
    const refills = await Promise.all(
      Array.from({ length: 5 }, () =>
        submit(b, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 15000 } })
      )
    );
    for (const res of refills) {
      expect(res.status).toBe(201);
    }

    const refillHandles = refills.map((res) => (res.body as TaskObject).handle);
    expect(refillHandles).toHaveLength(5);
    expect(new Set(refillHandles)).toEqual(new Set(freedNumbers.map((n) => `scrape-${n}`)));

    cap.close();
  });
});
