import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ALICE,
  BOB,
  EventCapture,
  T_EVENT,
  T_JOB,
  T_SETTLE,
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
 * Supplemental suite 5.8 — collect semantics (test-plan.md §5.8;
 * api-contract.md §6.4, §11 row 5). `GET /tasks/{handle}/result` is the one
 * GET with a side effect: legal from `ready` or `failed`, flips `collected`
 * to `true` exactly once, releases the handle, and emits exactly one
 * `collected` event. Re-reading it while the handle still resolves to the
 * same task is idempotent; once the handle is re-leased, it addresses the
 * new task; every other status is `409 invalid_state`.
 *
 * One server per FILE, spawned with `WORKER_CONCURRENCY: "1"` so a single
 * long-running blocker deterministically keeps a second submit `queued`
 * (used to exercise handle reuse and the queued/running/cancelled 409s).
 * This file only ever submits to `scrape` and `report` — two of the five
 * registered lanes (api-contract §1) — never an invented lane name.
 *
 * ── Canonical supplemental-suite lifecycle (test-plan.md §3.1-§3.2) ──
 * See auth-isolation.test.ts for the full rationale.
 */
describe("collect-semantics", () => {
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

  it("collects a ready task: 200, full object, collected true, result populated, error null, exactly one collected event", async () => {
    const b = server.baseUrl;
    const cap = new EventCapture(b, ALICE.rawKey, { server });
    await cap.ready;

    const DURATION_MS = 300;
    const submitRes = await submit(b, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: DURATION_MS },
    });
    expect(submitRes.status).toBe(201);
    const task = submitRes.body as TaskObject;
    expect(task.handle).toBe("scrape-1");

    await cap.waitFor(
      (e) => e.type === "ready" && e.task_id === task.id,
      T_JOB(DURATION_MS),
      `ready for ${task.handle} (task_id=${task.id})`,
      server
    );

    const collectRes = await collect(b, ALICE.rawKey, task.handle);
    expect(collectRes.status).toBe(200);
    const collected = collectRes.body as TaskObject;
    expect(collected.id).toBe(task.id);
    expect(collected.handle).toBe(task.handle);
    expect(collected.status).toBe("ready");
    expect(collected.collected).toBe(true);
    expect(collected.error).toBeNull();
    expect(collected.result).not.toBeNull();
    const result = collected.result as { message: unknown; slept_ms: unknown };
    expect(typeof result.message).toBe("string");
    expect(typeof result.slept_ms).toBe("number");

    // Exactly one `collected` event for this task_id: the waitFor below
    // proves at least one arrived; the throwaway-sentinel assertNever proves
    // no second one ever does (mirrors the idempotency test's technique).
    const collectedEvent = await cap.waitFor(
      (e) => e.type === "collected" && e.task_id === task.id,
      T_EVENT,
      `collected for ${task.handle} (task_id=${task.id})`,
      server
    );
    expect(collectedEvent.handle).toBe(task.handle);
    expect(collectedEvent.lane).toBe("scrape");

    const throwawayRes = await submit(b, ALICE.rawKey, {
      lane: "report",
      params: { duration_ms: 200 },
    });
    expect(throwawayRes.status).toBe(201);
    const throwaway = throwawayRes.body as TaskObject;

    await cap.assertNever(
      (e) => e.type === "collected" && e.task_id === task.id && e.id !== collectedEvent.id,
      {
        sentinel: (e) => e.type === "accepted" && e.task_id === throwaway.id,
        sentinelTimeoutMs: T_EVENT,
        settleMs: T_SETTLE,
        server,
      }
    );

    cap.close();
  });

  it("collects a failed task: 200, error populated, result null, one collected event; retry afterward is retired (409 failed)", async () => {
    const b = server.baseUrl;
    const cap = new EventCapture(b, ALICE.rawKey, { server });
    await cap.ready;

    const DURATION_MS = 200;
    const submitRes = await submit(b, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: DURATION_MS, fail: true },
      max_attempts: 1,
    });
    expect(submitRes.status).toBe(201);
    const task = submitRes.body as TaskObject;
    expect(task.handle).toBe("scrape-1");

    // max_attempts: 1 exhausts the budget on the first attempt — straight to
    // `failed`, no `retrying` in between (architecture.md §9).
    const failedEvent = await cap.waitFor(
      (e) => e.type === "failed" && e.task_id === task.id,
      T_JOB(DURATION_MS),
      `failed for ${task.handle} (task_id=${task.id})`,
      server
    );
    expect(failedEvent.handle).toBe(task.handle);

    const collectRes = await collect(b, ALICE.rawKey, task.handle);
    expect(collectRes.status).toBe(200);
    const collected = collectRes.body as TaskObject;
    expect(collected.id).toBe(task.id);
    expect(collected.status).toBe("failed");
    expect(collected.collected).toBe(true);
    expect(collected.result).toBeNull();
    expect(collected.error).not.toBeNull();
    expect(typeof collected.error?.reason).toBe("string");
    expect(typeof collected.error?.retryable).toBe("boolean");

    const collectedEvent = await cap.waitFor(
      (e) => e.type === "collected" && e.task_id === task.id,
      T_EVENT,
      `collected for ${task.handle} (task_id=${task.id})`,
      server
    );
    expect(collectedEvent.handle).toBe(task.handle);

    // Follow-up retry on the same (now-collected) handle: 409, current_status
    // still "failed" — collection has permanently retired the retry option.
    const retryRes = await retry(b, ALICE.rawKey, task.handle);
    expect(retryRes.status).toBe(409);
    const retryBody = retryRes.body as ErrorEnvelope;
    expect(retryBody.error.code).toBe("invalid_state");
    expect(retryBody.error.current_status).toBe("failed");

    // No second `collected` event was ever emitted by the retry attempt.
    const throwawayRes = await submit(b, ALICE.rawKey, {
      lane: "report",
      params: { duration_ms: 200 },
    });
    expect(throwawayRes.status).toBe(201);
    const throwaway = throwawayRes.body as TaskObject;

    await cap.assertNever(
      (e) => e.type === "collected" && e.task_id === task.id && e.id !== collectedEvent.id,
      {
        sentinel: (e) => e.type === "accepted" && e.task_id === throwaway.id,
        sentinelTimeoutMs: T_EVENT,
        settleMs: T_SETTLE,
        server,
      }
    );

    cap.close();
  });

  it("is idempotent while the handle still resolves to the same task: identical body, no second collected event", async () => {
    const b = server.baseUrl;
    const cap = new EventCapture(b, ALICE.rawKey, { server });
    await cap.ready;

    const DURATION_MS = 200;
    const submitRes = await submit(b, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: DURATION_MS },
    });
    expect(submitRes.status).toBe(201);
    const task = submitRes.body as TaskObject;

    await cap.waitFor(
      (e) => e.type === "ready" && e.task_id === task.id,
      T_JOB(DURATION_MS),
      `ready for ${task.handle} (task_id=${task.id})`,
      server
    );

    const firstCollectRes = await collect(b, ALICE.rawKey, task.handle);
    expect(firstCollectRes.status).toBe(200);
    const firstBody = firstCollectRes.body as TaskObject;
    expect(firstBody.collected).toBe(true);

    const firstCollectedEvent = await cap.waitFor(
      (e) => e.type === "collected" && e.task_id === task.id,
      T_EVENT,
      `collected for ${task.handle} (task_id=${task.id})`,
      server
    );

    // Second GET .../result while the handle still resolves to the same
    // task: 200, identical body, idempotently — no state change.
    const secondCollectRes = await collect(b, ALICE.rawKey, task.handle);
    expect(secondCollectRes.status).toBe(200);
    expect(secondCollectRes.body).toEqual(firstBody);

    // Third read for good measure — still idempotent.
    const thirdCollectRes = await collect(b, ALICE.rawKey, task.handle);
    expect(thirdCollectRes.status).toBe(200);
    expect(thirdCollectRes.body).toEqual(firstBody);

    // Sentinel: a subsequent UNRELATED submit's `accepted` event. The
    // forbidden predicate excludes the one legitimate `collected` event
    // already seen (by its SSE id) and flags any event beyond it.
    const throwawayRes = await submit(b, ALICE.rawKey, {
      lane: "report",
      params: { duration_ms: 200 },
    });
    expect(throwawayRes.status).toBe(201);
    const throwaway = throwawayRes.body as TaskObject;

    await cap.assertNever(
      (e) =>
        e.type === "collected" && e.task_id === task.id && e.id !== firstCollectedEvent.id,
      {
        sentinel: (e) => e.type === "accepted" && e.task_id === throwaway.id,
        sentinelTimeoutMs: T_EVENT,
        settleMs: T_SETTLE,
        server,
      }
    );

    cap.close();
  });

  it("once the handle is reused by a new queued task, GET .../result on that handle addresses the new task (409 queued)", async () => {
    const b = server.baseUrl;
    const cap = new EventCapture(b, ALICE.rawKey, { server });
    await cap.ready;

    // Step 1: run a short scrape job to `ready` on its own (nothing else
    // competing for the single global slot yet), then collect it —
    // releasing the handle for reuse.
    const DURATION_MS = 200;
    const firstRes = await submit(b, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: DURATION_MS },
    });
    expect(firstRes.status).toBe(201);
    const first = firstRes.body as TaskObject;
    expect(first.handle).toBe("scrape-1");

    await cap.waitFor(
      (e) => e.type === "ready" && e.task_id === first.id,
      T_JOB(DURATION_MS),
      `ready for ${first.handle} (task_id=${first.id})`,
      server
    );

    const collectRes = await collect(b, ALICE.rawKey, first.handle);
    expect(collectRes.status).toBe(200);
    expect((collectRes.body as TaskObject).collected).toBe(true);

    // Step 2: occupy the single global concurrency slot with a long-running
    // blocker on the OTHER registered lane, so the reused handle's new task
    // is observably `queued` rather than racing straight to `running`.
    const BLOCKER_DURATION_MS = 30_000;
    const blockerRes = await submit(b, ALICE.rawKey, {
      lane: "report",
      params: { duration_ms: BLOCKER_DURATION_MS },
    });
    expect(blockerRes.status).toBe(201);
    const blocker = blockerRes.body as TaskObject;

    await cap.waitFor(
      (e) => e.type === "running" && e.task_id === blocker.id,
      T_EVENT,
      `running for blocker (task_id=${blocker.id})`,
      server
    );

    // Step 3: submit a second scrape job — the allocator's lowest-free rule
    // hands it the freed handle back, as a brand-new task, and it stays
    // `queued` behind the blocker (the only global slot is taken).
    const secondRes = await submit(b, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: DURATION_MS },
    });
    expect(secondRes.status).toBe(201);
    const second = secondRes.body as TaskObject;
    expect(second.handle).toBe("scrape-1");
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("queued");

    const getRes = await getTask(b, ALICE.rawKey, "scrape-1");
    expect(getRes.status).toBe(200);
    expect((getRes.body as TaskObject).id).toBe(second.id);
    expect((getRes.body as TaskObject).status).toBe("queued");

    // Step 4: collect on the reused handle now addresses the NEW task, which
    // is `queued` — 409, current_status echoing the actual state (resolution
    // favors the active holder over the collected former holder).
    const reuseCollectRes = await collect(b, ALICE.rawKey, "scrape-1");
    expect(reuseCollectRes.status).toBe(409);
    const reuseBody = reuseCollectRes.body as ErrorEnvelope;
    expect(reuseBody.error.code).toBe("invalid_state");
    expect(reuseBody.error.current_status).toBe("queued");

    cap.close();
  });

  it("rejects collect on queued, running, and cancelled tasks with 409 invalid_state echoing current_status", async () => {
    const b = server.baseUrl;
    const cap = new EventCapture(b, ALICE.rawKey, { server });
    await cap.ready;

    // A occupies the single global concurrency slot.
    const JOB_DURATION_MS = 30_000;
    const aRes = await submit(b, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: JOB_DURATION_MS },
    });
    expect(aRes.status).toBe(201);
    const a = aRes.body as TaskObject;
    expect(a.handle).toBe("scrape-1");

    await cap.waitFor(
      (e) => e.type === "running" && e.task_id === a.id,
      T_EVENT,
      `running for A (task_id=${a.id})`,
      server
    );

    // Collect while `running`.
    const runningCollect = await collect(b, ALICE.rawKey, a.handle);
    expect(runningCollect.status).toBe(409);
    const runningBody = runningCollect.body as ErrorEnvelope;
    expect(runningBody.error.code).toBe("invalid_state");
    expect(runningBody.error.current_status).toBe("running");

    // B stays `queued` behind A (the only global slot is taken).
    const bRes = await submit(b, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: JOB_DURATION_MS },
    });
    expect(bRes.status).toBe(201);
    const bTask = bRes.body as TaskObject;
    expect(bTask.handle).toBe("scrape-2");
    expect(bTask.status).toBe("queued");

    // Collect while `queued`.
    const queuedCollect = await collect(b, ALICE.rawKey, bTask.handle);
    expect(queuedCollect.status).toBe(409);
    const queuedBody = queuedCollect.body as ErrorEnvelope;
    expect(queuedBody.error.code).toBe("invalid_state");
    expect(queuedBody.error.current_status).toBe("queued");

    // Cancel B while still queued, then collect on the now-`cancelled` task.
    const cancelRes = await cancel(b, ALICE.rawKey, bTask.handle);
    expect(cancelRes.status).toBe(200);
    await cap.waitFor(
      (e) => e.type === "cancelled" && e.task_id === bTask.id,
      T_EVENT,
      `cancelled for B (task_id=${bTask.id})`,
      server
    );

    const cancelledCollect = await collect(b, ALICE.rawKey, bTask.handle);
    expect(cancelledCollect.status).toBe(409);
    const cancelledBody = cancelledCollect.body as ErrorEnvelope;
    expect(cancelledBody.error.code).toBe("invalid_state");
    expect(cancelledBody.error.current_status).toBe("cancelled");

    // A is left `running`; afterEach's settle() cancels it before the next
    // test's truncation.
    cap.close();
  });
});
