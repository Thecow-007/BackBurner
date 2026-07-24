import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ALICE,
  EventCapture,
  T_EVENT,
  T_JOB,
  T_SETTLE,
  cancel,
  getTask,
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
 * Spec (assessment spec, success criterion 6): "Cancellation, running and
 * queued. Submit a job with duration_ms: 30000 and cancel it mid-run: it
 * moves to cancelled, no later ready event arrives for it (the worker
 * actually stopped), and /events carried a cancelled event. Repeat for a
 * job still sitting in the queue behind the concurrency limit: same
 * result."
 *
 * test-plan.md §4.6. WORKER_CONCURRENCY=2; ES connected before the first
 * submit. Four jobs, all duration_ms: 30000: A is the sentinel that runs to
 * completion, B is cancelled mid-run, C is cancelled while queued, D is the
 * slot-release probe submitted right after B's `cancelled` event.
 */
describe("criterion-06-cancel-running-and-queued", () => {
  let server: ServerHandle | undefined;
  let events: EventCapture | undefined;

  beforeEach(async () => {
    await resetDatabase();
    server = await spawnServer({ WORKER_CONCURRENCY: "2" });
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

  it("stops a running job on cancel and cancels a queued job before it ever starts, without stranding the pool", async () => {
    const srv = server!;
    const cap = events!;

    const JOB_DURATION_MS = 30_000;
    // test-plan.md §3.6 rule 2 / §9 rule 4: lower bounds proving work
    // genuinely ran carry a 10% tolerance, derived here from the pinned job
    // duration rather than hardcoded as a bare magic number.
    const MIN_READY_GAP_MS = JOB_DURATION_MS * 0.9;

    // Step 1: submit A and B — both occupy the two available slots.
    const aRes = await submit(srv.baseUrl, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: JOB_DURATION_MS },
    });
    expect(aRes.status).toBe(201);
    const a = aRes.body as TaskObject;
    expect(a.handle).toBe("scrape-1");

    const bRes = await submit(srv.baseUrl, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: JOB_DURATION_MS },
    });
    expect(bRes.status).toBe(201);
    const b = bRes.body as TaskObject;
    expect(b.handle).toBe("scrape-2");

    const runningAB = await cap.waitForCount(
      (e) => e.type === "running" && (e.task_id === a.id || e.task_id === b.id),
      2,
      T_EVENT,
      srv
    );
    const aRunning = runningAB.find((e) => e.task_id === a.id);
    if (!aRunning) {
      throw new Error("expected a `running` event for A among the first two running events");
    }

    // Step 2: submit C, behind the concurrency limit.
    const cRes = await submit(srv.baseUrl, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: JOB_DURATION_MS },
    });
    expect(cRes.status).toBe(201);
    const c = cRes.body as TaskObject;
    expect(c.handle).toBe("scrape-3");

    const cCheck = await getTask(srv.baseUrl, ALICE.rawKey, "scrape-3");
    expect(cCheck.status).toBe(200);
    expect((cCheck.body as TaskObject).status).toBe("queued");

    // Step 3: cancel queued C.
    const cCancelRes = await cancel(srv.baseUrl, ALICE.rawKey, "scrape-3");
    expect(cCancelRes.status).toBe(200);
    expect((cCancelRes.body as TaskObject).status).toBe("cancelled");
    const cCancelled = await cap.waitFor(
      (e) => e.type === "cancelled" && e.task_id === c.id,
      T_EVENT,
      `cancelled for C (task_id=${c.id})`,
      srv
    );
    expect(cCancelled.handle).toBe("scrape-3");
    expect(cCancelled.lane).toBe("scrape");

    // Step 4: cancel running B (mid-run, ~2s into its 30s job).
    const bCancelRes = await cancel(srv.baseUrl, ALICE.rawKey, "scrape-2");
    expect(bCancelRes.status).toBe(200);
    expect((bCancelRes.body as TaskObject).status).toBe("cancelled");
    const bCancelled = await cap.waitFor(
      (e) => e.type === "cancelled" && e.task_id === b.id,
      T_EVENT,
      `cancelled for B (task_id=${b.id})`,
      srv
    );
    expect(bCancelled.handle).toBe("scrape-2");
    expect(bCancelled.lane).toBe("scrape");

    // Step 5: slot-release probe. Submit D immediately after B's
    // `cancelled` event and require it to reach `running` promptly. With
    // WORKER_CONCURRENCY=2 and A occupying one slot, D can only start
    // promptly if B's worker genuinely stopped and released its slot — an
    // engine that never aborts B and lets it run silently holds the slot
    // ~28s longer, timing this wait out. The stale-completion discard rule
    // (api-contract §6.5) suppresses any ghost `ready` for B, so the
    // MUST-NOT assertion below cannot catch that engine on its own; this
    // probe closes the gap (test-plan.md §4.6).
    const dRes = await submit(srv.baseUrl, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: JOB_DURATION_MS },
    });
    expect(dRes.status).toBe(201);
    const d = dRes.body as TaskObject;

    await cap.waitFor(
      (e) => e.type === "running" && e.task_id === d.id,
      T_EVENT,
      `running for D (task_id=${d.id})`,
      srv
    );

    // Step 6: A is the sentinel — it must run to completion undisturbed,
    // proving the worker pool and stream stayed healthy through the entire
    // window in which B and C would have finished had cancellation not
    // truly stopped them.
    const aReady = await cap.waitFor(
      (e) => e.type === "ready" && e.task_id === a.id,
      T_JOB(JOB_DURATION_MS),
      `ready for A (task_id=${a.id})`,
      srv
    );
    expect(aReady.id).toBeGreaterThan(aRunning.id);
    const gapMs = new Date(aReady.at).getTime() - new Date(aRunning.at).getTime();
    expect(gapMs).toBeGreaterThanOrEqual(MIN_READY_GAP_MS);
    expect(gapMs).toBeLessThanOrEqual(T_JOB(JOB_DURATION_MS));

    // MUST NOT arrive, from submit until A.ready + T_SETTLE (assertNever
    // with A's ready as sentinel): any `ready` or `failed` event for B or
    // C; any `running` event for C. The predicate is deliberately scoped to
    // B and C only — D's eventual `ready` is exempt (test-plan.md §4.6).
    await cap.assertNever(
      (e) =>
        (e.task_id === b.id && (e.type === "ready" || e.type === "failed")) ||
        (e.task_id === c.id &&
          (e.type === "ready" || e.type === "failed" || e.type === "running")),
      {
        sentinel: (e) => e.type === "ready" && e.task_id === a.id,
        sentinelTimeoutMs: T_JOB(JOB_DURATION_MS),
        settleMs: T_SETTLE,
        server: srv,
      }
    );

    // Step 7: final snapshot — A ready, B cancelled, C cancelled, D running
    // or ready.
    const finalList = await listTasks(srv.baseUrl, ALICE.rawKey, { limit: 200 });
    expect(finalList.status).toBe(200);
    const tasks = (finalList.body as TaskListResponse).tasks;
    const byId = new Map(tasks.map((t) => [t.id, t]));

    expect(byId.get(a.id)?.status).toBe("ready");
    expect(byId.get(b.id)?.status).toBe("cancelled");
    expect(byId.get(c.id)?.status).toBe("cancelled");
    expect(["running", "ready"]).toContain(byId.get(d.id)?.status);
  });
});
