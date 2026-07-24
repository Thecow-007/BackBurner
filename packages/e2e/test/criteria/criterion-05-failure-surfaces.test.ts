import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ALICE,
  EventCapture,
  T_EVENT,
  T_RETRY_CHAIN,
  T_SETTLE,
  getTask,
  resetDatabase,
  retry,
  spawnServer,
  stopServer,
  submit,
  type ServerHandle,
  type TaskObject,
} from "../../src/index.js";

/**
 * Spec (assessment spec, success criterion 5): "Failure surfaces, no
 * auto-collect. Submit a job with fail: true. It lands in failed with
 * error.retryable set and a reason; the /events stream carried a failed
 * event; the job is not silently collected; the operator can retry it."
 *
 * test-plan.md §4.5. Default env (BACKOFF_BASE_MS=100 collapses the full
 * 3-attempt retry chain to ~1.5s). All actions as e2e-alice; ES connected
 * before the first submit.
 */
describe("criterion-05-failure-surfaces", () => {
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

  it("surfaces a failure with an honest reason, never auto-collects, and allows operator retry", async () => {
    const srv = server!;
    const cap = events!;

    // Step 1: submit a job that always fails (default max_attempts = 3).
    const submitRes = await submit(srv.baseUrl, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: 300, fail: true },
    });
    expect(submitRes.status).toBe(201);
    const task = submitRes.body as TaskObject;
    expect(task.handle).toBe("scrape-1");
    const taskId = task.id;

    // Step 2: wait for the terminal `failed` event.
    const failedEvent = await cap.waitFor(
      (e) => e.type === "failed" && e.task_id === taskId,
      T_RETRY_CHAIN,
      `failed for scrape-1 (task_id=${taskId})`,
      srv
    );

    // The `failed` event carries the spec shape: type, handle, lane, plus
    // the worker's exact honest reason string and retryable: true
    // (api-contract §8 — never a generic "failed").
    expect(failedEvent.handle).toBe("scrape-1");
    expect(failedEvent.lane).toBe("scrape");
    expect(failedEvent.reason).toBe("mock failure requested via params.fail");
    expect(failedEvent.retryable).toBe(true);

    // Exactly two `retrying` events for this task_id preceded `failed`:
    // attempts 1 and 2 were auto-retried with backoff, the third exhausted
    // the budget (architecture.md §9; api-contract §8's `retrying` extension).
    const retryingEvents = cap
      .all()
      .filter((e) => e.type === "retrying" && e.task_id === taskId);
    expect(retryingEvents).toHaveLength(2);
    for (const retrying of retryingEvents) {
      expect(retrying.id).toBeLessThan(failedEvent.id);
    }

    // MUST NOT arrive at any point before step 4 (the retry call): any
    // ready, cancelled, or collected event for this task_id. `failed` is
    // the sentinel that closes the window (test-plan.md §3.6 rule 3); the
    // assertNever settle tail (T_SETTLE) additionally proves nothing
    // appears immediately afterward either.
    await cap.assertNever(
      (e) =>
        e.task_id === taskId &&
        (e.type === "ready" || e.type === "cancelled" || e.type === "collected"),
      {
        sentinel: (e) => e.type === "failed" && e.task_id === taskId,
        sentinelTimeoutMs: T_RETRY_CHAIN,
        settleMs: T_SETTLE,
        server: srv,
      }
    );

    // Step 3: not silently collected — the failure has fully surfaced.
    const getRes = await getTask(srv.baseUrl, ALICE.rawKey, "scrape-1");
    expect(getRes.status).toBe(200);
    const failedTask = getRes.body as TaskObject;
    expect(failedTask.status).toBe("failed");
    expect(failedTask.error).toEqual({
      reason: "mock failure requested via params.fail",
      retryable: true,
    });
    expect(failedTask.attempts).toBe(3);
    expect(failedTask.collected).toBe(false);
    expect(failedTask.result).toBeNull();

    // Step 4: the operator can retry it, while still uncollected — a fresh
    // budget (attempts reset to 0), re-queued.
    const retryRes = await retry(srv.baseUrl, ALICE.rawKey, "scrape-1");
    expect(retryRes.status).toBe(200);
    const retried = retryRes.body as TaskObject;
    expect(retried.status).toBe("queued");
    expect(retried.attempts).toBe(0);

    // Step 5: the retried job is genuinely re-dispatched.
    await cap.waitFor(
      (e) => e.type === "running" && e.task_id === taskId,
      T_EVENT,
      `running after retry for scrape-1 (task_id=${taskId})`,
      srv
    );
  });
});
