import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ALICE,
  getTask,
  listTasks,
  resetDatabase,
  spawnServer,
  stopServer,
  submit,
  T_HTTP,
  type ServerHandle,
  type TaskObject,
} from "../../src/index.js";

/**
 * criterion-01-instant-handle (test-plan.md §4.1).
 *
 * Spec: "Instant handle. Submit a scrape job with `duration_ms: 10000`. The
 * `POST /tasks` response returns `{ "handle": "scrape-1", "status": "queued" }`
 * in well under one second, far less than the 10s the job will take. The
 * handle is in hand long before the work is done."
 *
 * Pure HTTP latency check — no event stream needed.
 */

/** Pinned job duration for this criterion (test-plan.md §4.1 step 2) — the
 * job is far longer than T_HTTP, so it cannot possibly finish inside the
 * measured window. */
const DURATION_MS = 10_000;

describe("criterion-01-instant-handle", () => {
  let server: ServerHandle | undefined;

  beforeEach(async () => {
    await resetDatabase();
    server = await spawnServer();
  });

  afterEach(async () => {
    if (server) {
      await stopServer(server);
    }
  });

  it("returns handle scrape-1/queued in well under a second, before the 10s job finishes", async () => {
    const s = server;
    if (!s) throw new Error("server was not spawned");

    // Step 1: unmeasured warm-up — exercises the DB path once (pool
    // connection, route/schema compilation) so first-request costs never
    // land inside the one timing assertion the flakiness policy forbids
    // widening (test-plan.md §4.1 step 1, §9).
    await listTasks(s.baseUrl, ALICE.rawKey);

    // Step 2: the measured POST /tasks — only this call is timed.
    const t0 = performance.now();
    const submitRes = await submit(s.baseUrl, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: DURATION_MS },
    });
    const t1 = performance.now();

    expect(submitRes.status).toBe(201);
    expect(t1 - t0).toBeLessThan(T_HTTP);

    const task = submitRes.body as TaskObject;

    // All nine spec fields, spec shapes (api-contract §4).
    expect(task.handle).toBe("scrape-1");
    expect(task.status).toBe("queued");
    expect(task.lane).toBe("scrape");
    expect(typeof task.params).toBe("object");
    expect(task.params).not.toBeNull();
    expect(task.result).toBeNull();
    expect(task.error).toBeNull();
    expect(task.collected).toBe(false);
    expect(task.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(task.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Sanity: the timestamps really do parse as valid instants.
    expect(Number.isNaN(Date.parse(task.created_at))).toBe(false);
    expect(Number.isNaN(Date.parse(task.updated_at))).toBe(false);

    // Step 3: the handle is in hand long before the work is done — the job
    // is demonstrably not finished when GET /tasks/scrape-1 is fetched.
    const getRes = await getTask(s.baseUrl, ALICE.rawKey, "scrape-1");
    expect(getRes.status).toBe(200);
    const fetched = getRes.body as TaskObject;
    expect(["queued", "running"]).toContain(fetched.status);
  });
});
