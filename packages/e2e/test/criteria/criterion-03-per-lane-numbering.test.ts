import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ALICE,
  listTasks,
  resetDatabase,
  spawnServer,
  stopServer,
  submit,
  type ServerHandle,
  type TaskListResponse,
  type TaskObject,
} from "../../src/index.js";

/**
 * criterion-03-per-lane-numbering (test-plan.md §4.3).
 *
 * Spec: "Per-category numbering. Submit one `scrape` and one `report` job.
 * They get `scrape-1` and `report-1`, not `scrape-1` and `scrape-2`. Submit
 * a second `scrape` while the first still runs: it gets `scrape-2`."
 */

/** Pinned job duration (test-plan.md §4.3 steps 1-3) — long enough that the
 * first scrape job still has the whole window left when the second is
 * submitted. */
const DURATION_MS = 10_000;

describe("criterion-03-per-lane-numbering", () => {
  let server: ServerHandle | undefined;

  beforeEach(async () => {
    await resetDatabase();
    server = await spawnServer();
  });

  afterEach(async () => {
    if (server) await stopServer(server);
  });

  it("numbers handles independently per lane", async () => {
    const s = server;
    if (!s) throw new Error("server was not spawned");

    // Step 1: first scrape.
    const scrapeARes = await submit(s.baseUrl, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: DURATION_MS },
    });
    expect(scrapeARes.status).toBe(201);
    const scrapeA = scrapeARes.body as TaskObject;
    expect(scrapeA.handle).toBe("scrape-1");

    // Step 2: first report.
    const reportARes = await submit(s.baseUrl, ALICE.rawKey, {
      lane: "report",
      params: { duration_ms: DURATION_MS },
    });
    expect(reportARes.status).toBe(201);
    const reportA = reportARes.body as TaskObject;
    expect(reportA.handle).toBe("report-1");

    // Step 3: second scrape, submitted immediately while the first still
    // has ~10s left — must get scrape-2, not collide with scrape-1.
    const scrapeBRes = await submit(s.baseUrl, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: DURATION_MS },
    });
    expect(scrapeBRes.status).toBe(201);
    const scrapeB = scrapeBRes.body as TaskObject;
    expect(scrapeB.handle).toBe("scrape-2");

    // The three 201 bodies carry exactly scrape-1, report-1, scrape-2.
    expect([scrapeA.handle, reportA.handle, scrapeB.handle]).toEqual([
      "scrape-1",
      "report-1",
      "scrape-2",
    ]);

    // Step 4: list — exactly three tasks; handles and lanes match; the two
    // scrape tasks have distinct task_ids.
    const listRes = await listTasks(s.baseUrl, ALICE.rawKey);
    expect(listRes.status).toBe(200);
    const list = listRes.body as TaskListResponse;
    expect(list.tasks).toHaveLength(3);

    const byHandle = new Map<string, TaskObject>(
      list.tasks.map((t): [string, TaskObject] => [t.handle, t])
    );
    expect(byHandle.get("scrape-1")?.lane).toBe("scrape");
    expect(byHandle.get("report-1")?.lane).toBe("report");
    expect(byHandle.get("scrape-2")?.lane).toBe("scrape");
    expect(byHandle.get("scrape-1")?.id).toBe(scrapeA.id);
    expect(byHandle.get("report-1")?.id).toBe(reportA.id);
    expect(byHandle.get("scrape-2")?.id).toBe(scrapeB.id);

    expect(scrapeA.id).not.toBe(scrapeB.id);
  });
});
