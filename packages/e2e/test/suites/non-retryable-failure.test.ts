import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ALICE,
  BOB,
  EventCapture,
  T_EVENT,
  T_RETRY_CHAIN,
  T_SETTLE,
  getTask,
  resetDatabase,
  retry,
  settle,
  spawnServer,
  stopServer,
  submit,
  type ServerHandle,
  type TaskObject,
} from "../../src/index.js";

/**
 * Supplemental suite 5.10 — non-retryable failure (test-plan.md §5.10;
 * api-contract.md §1, §8). The spec names two permanent-failure flavors;
 * criterion 05 proves repeated exhaustion via `params.fail`, this suite
 * proves "a job marked non-retryable" via `params.fail_permanent`: it lands
 * in `failed` on its FIRST attempt (attempts: 1), the attempt budget is
 * ignored, `retryable: false` short-circuits auto-retry (zero `retrying`
 * events), `fail_permanent` wins over `fail` when both are set, and operator
 * retry stays legal afterward — `retryable` gates auto-retry only.
 *
 * Canonical supplemental-suite lifecycle (test-plan.md §3.1-§3.2, mirrored
 * from auth-isolation.test.ts): one server per FILE, `settle()` in
 * `afterEach` for both actors before the next truncation.
 */
describe("non-retryable-failure", () => {
  let server: ServerHandle;

  beforeAll(async () => {
    server = await spawnServer();
  });

  afterAll(async () => {
    await stopServer(server);
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
    for (const user of [ALICE, BOB]) {
      const cap = new EventCapture(server.baseUrl, user.rawKey, { server });
      await cap.ready;
      await settle(server.baseUrl, user.rawKey, cap, { server });
      cap.close();
    }
  });

  it("lands in failed after exactly one attempt, skips the retry budget, and still allows operator retry", async () => {
    const b = server.baseUrl;
    const events = new EventCapture(b, ALICE.rawKey, { server });
    await events.ready;

    // Step 1: submit a job that fails permanently (default max_attempts 3).
    const submitRes = await submit(b, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: 300, fail_permanent: true },
    });
    expect(submitRes.status).toBe(201);
    const task = submitRes.body as TaskObject;
    expect(task.handle).toBe("scrape-1");
    const taskId = task.id;

    // Step 2: wait for the terminal `failed` event — reached on the FIRST
    // attempt, no auto-retry chain to wait out.
    const failedEvent = await events.waitFor(
      (e) => e.type === "failed" && e.task_id === taskId,
      T_RETRY_CHAIN,
      `failed for scrape-1 (task_id=${taskId})`,
      server
    );

    // The `failed` event carries the spec shape (api-contract §8) with the
    // exact permanent-failure reason, distinct from the transient one, and
    // retryable: false.
    expect(failedEvent.handle).toBe("scrape-1");
    expect(failedEvent.lane).toBe("scrape");
    expect(failedEvent.reason).toBe(
      "mock permanent failure requested via params.fail_permanent"
    );
    expect(failedEvent.retryable).toBe(false);

    // Step 3: the stream carried accepted -> running -> failed with ZERO
    // `retrying` events — `retryable: false` short-circuits the budget
    // entirely rather than exhausting it (test-plan.md §5.10 point 3).
    const accepted = events
      .all()
      .find((e) => e.type === "accepted" && e.task_id === taskId);
    const running = events
      .all()
      .find((e) => e.type === "running" && e.task_id === taskId);
    expect(accepted).toBeDefined();
    expect(running).toBeDefined();
    expect(accepted!.id).toBeLessThan(running!.id);
    expect(running!.id).toBeLessThan(failedEvent.id);

    await events.assertNever(
      (e) => e.type === "retrying" && e.task_id === taskId,
      {
        sentinel: (e) => e.type === "failed" && e.task_id === taskId,
        sentinelTimeoutMs: T_RETRY_CHAIN,
        settleMs: T_SETTLE,
        server,
      }
    );

    // Step 4: not silently collected; attempts: 1, budget ignored.
    const getRes = await getTask(b, ALICE.rawKey, "scrape-1");
    expect(getRes.status).toBe(200);
    const failedTask = getRes.body as TaskObject;
    expect(failedTask.status).toBe("failed");
    expect(failedTask.attempts).toBe(1);
    expect(failedTask.error).toEqual({
      reason: "mock permanent failure requested via params.fail_permanent",
      retryable: false,
    });
    expect(failedTask.result).toBeNull();

    // Step 5: operator retry is still legal on a failed, uncollected task —
    // `retryable: false` gates auto-retry only, not operator action. Fresh
    // budget: attempts reset to 0.
    const retryRes = await retry(b, ALICE.rawKey, "scrape-1");
    expect(retryRes.status).toBe(200);
    const retried = retryRes.body as TaskObject;
    expect(retried.status).toBe("queued");
    expect(retried.attempts).toBe(0);

    // Step 6: the retried job is genuinely re-dispatched.
    await events.waitFor(
      (e) => e.type === "running" && e.task_id === taskId,
      T_EVENT,
      `running after retry for scrape-1 (task_id=${taskId})`,
      server
    );

    events.close();
  });

  it("fail_permanent wins over fail when both are set: lands in failed with retryable false and no retrying events", async () => {
    const b = server.baseUrl;
    const events = new EventCapture(b, ALICE.rawKey, { server });
    await events.ready;

    const submitRes = await submit(b, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: 300, fail: true, fail_permanent: true },
    });
    expect(submitRes.status).toBe(201);
    const task = submitRes.body as TaskObject;
    const taskId = task.id;

    const failedEvent = await events.waitFor(
      (e) => e.type === "failed" && e.task_id === taskId,
      T_RETRY_CHAIN,
      `failed for scrape-1 (task_id=${taskId}, fail+fail_permanent precedence)`,
      server
    );
    expect(failedEvent.retryable).toBe(false);
    expect(failedEvent.reason).toBe(
      "mock permanent failure requested via params.fail_permanent"
    );

    // No `retrying` events at any point: fail_permanent's non-retryable
    // failure wins outright over fail's retryable one.
    await events.assertNever(
      (e) => e.type === "retrying" && e.task_id === taskId,
      {
        sentinel: (e) => e.type === "failed" && e.task_id === taskId,
        sentinelTimeoutMs: T_RETRY_CHAIN,
        settleMs: T_SETTLE,
        server,
      }
    );

    const getRes = await getTask(b, ALICE.rawKey, "scrape-1");
    const failedTask = getRes.body as TaskObject;
    expect(failedTask.status).toBe("failed");
    expect(failedTask.attempts).toBe(1);
    expect(failedTask.error?.retryable).toBe(false);
    expect(failedTask.error?.reason).toBe(
      "mock permanent failure requested via params.fail_permanent"
    );

    events.close();
  });
});
