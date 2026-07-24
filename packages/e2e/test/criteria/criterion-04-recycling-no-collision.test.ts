import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ALICE,
  EventCapture,
  T_JOB,
  collect,
  getTask,
  resetDatabase,
  spawnServer,
  stopServer,
  submit,
  type ServerHandle,
  type TaskObject,
} from "../../src/index.js";

/**
 * Spec (assessment spec, success criterion 4): "Recycling without
 * collision. Run scrape-1 to completion and collect it, then submit a new
 * scrape job: it may reuse scrape-1. But while a scrape-1 is still queued,
 * running, or finished-but-uncollected, a newly submitted scrape job must be
 * scrape-2. A handle is never reused while its previous owner is still
 * active."
 *
 * test-plan.md §4.4. All actions as e2e-alice; ES connected before the
 * first submit so no event can be missed.
 */
describe("criterion-04-recycling-no-collision", () => {
  let server: ServerHandle | undefined;
  let events: EventCapture | undefined;

  beforeEach(async () => {
    await resetDatabase();
    server = await spawnServer();
    events = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    // Wait for the stream to be open before the first submit, so no event
    // can be missed (test-plan.md §4 intro: "ES" means connected first).
    await events.ready;
  });

  afterEach(async () => {
    events?.close();
    if (server) {
      await stopServer(server);
    }
  });

  it("never reuses a handle while its previous owner is still active", async () => {
    const srv = server!;
    const cap = events!;

    // Step 1: submit A (duration_ms 1000) and run it to `ready`.
    const aRes = await submit(srv.baseUrl, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: 1000 },
    });
    expect(aRes.status).toBe(201);
    const a = aRes.body as TaskObject;
    expect(a.handle).toBe("scrape-1");

    await cap.waitFor(
      (e) => e.type === "ready" && e.task_id === a.id,
      T_JOB(1000),
      `ready for A (task_id=${a.id})`,
      srv
    );

    // Step 2: A is now ready-but-uncollected — still the active holder of
    // scrape-1 (api-contract §5: "active" spans in-flight and
    // finished-but-uncollected). Submit B: it must get scrape-2.
    const bRes = await submit(srv.baseUrl, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: 10000 },
    });
    expect(bRes.status).toBe(201);
    const b = bRes.body as TaskObject;
    expect(b.handle).toBe("scrape-2");

    // Step 3: collect A — this releases scrape-1.
    const collectRes = await collect(srv.baseUrl, ALICE.rawKey, "scrape-1");
    expect(collectRes.status).toBe(200);
    const collected = collectRes.body as TaskObject;
    expect(collected.collected).toBe(true);

    // Step 4: submit C. BackBurner's allocator guarantees lowest-free, so
    // (stricter than the spec's bare "may reuse") C deterministically gets
    // scrape-1 back, as a *new* task under the reused alias.
    const cRes = await submit(srv.baseUrl, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: 10000 },
    });
    expect(cRes.status).toBe(201);
    const c = cRes.body as TaskObject;
    expect(c.handle).toBe("scrape-1");
    expect(c.id).not.toBe(a.id);

    // Step 5: GET /tasks/scrape-1 resolves to the active holder C, not the
    // collected former holder A.
    const getRes = await getTask(srv.baseUrl, ALICE.rawKey, "scrape-1");
    expect(getRes.status).toBe(200);
    const resolved = getRes.body as TaskObject;
    expect(resolved.id).toBe(c.id);
    expect(["queued", "running"]).toContain(resolved.status);
  });
});
