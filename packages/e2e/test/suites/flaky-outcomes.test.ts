import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ALICE,
  EventCapture,
  T_EVENT,
  T_JOB,
  T_RETRY_CHAIN,
  getHistory,
  getTask,
  resetDatabase,
  settle,
  spawnServer,
  stopServer,
  submit,
  type ErrorEnvelope,
  type HistoryResponse,
  type HistoryTransition,
  type ServerHandle,
  type TaskObject,
} from "../../src/index.js";

/**
 * Supplemental suite 5.12 — flaky mock outcomes (`params.fail_times`,
 * api-contract.md §1, ADR 0021).
 *
 * `fail_times: n` makes the mock worker return a **retryable** failure while
 * the current attempt number is ≤ n and succeed on every attempt after it —
 * the one shape the other two failure params cannot express: a job that
 * genuinely recovers. What is under test is not just "it eventually goes
 * ready" but that the whole journal is coherent while it does: one `running`
 * per attempt, a `retrying` hop between them carrying the honest reason, and
 * `attempts` on the final task object equal to the attempt that actually
 * succeeded.
 *
 * It also pins the attempt-aware worker context (`ctx.attempt` /
 * `ctx.maxAttempts`, ADR 0021) from the outside: the reason strings name the
 * attempt number the worker saw, and the `running` transitions journal the
 * attempt number the ENGINE saw. If those two ever drifted apart, the
 * cross-check in the first test below would fail.
 *
 * ── Canonical supplemental-suite lifecycle (test-plan.md §3.1-§3.2) ──
 * One server per FILE, `settle()` + truncate between tests.
 */
describe("flaky-outcomes", () => {
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
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    await settle(server.baseUrl, ALICE.rawKey, cap, { server });
    cap.close();
  });

  /** Short enough that a three-attempt chain finishes inside T_RETRY_CHAIN,
   * long enough to be a real, observable run. */
  const SHORT_MS = 200;

  function flakyReason(attempt: number, failTimes: number): string {
    return `mock flaky failure: attempt ${attempt} of ${failTimes} scheduled to fail via params.fail_times`;
  }

  async function submitTask(params: Record<string, unknown>, maxAttempts?: number): Promise<TaskObject> {
    const body: Record<string, unknown> = { lane: "scrape", params };
    if (maxAttempts !== undefined) body.max_attempts = maxAttempts;
    const res = await submit(server.baseUrl, ALICE.rawKey, body);
    expect(res.status, `submit failed: ${JSON.stringify(res.body)}`).toBe(201);
    return res.body as TaskObject;
  }

  async function history(id: string): Promise<HistoryTransition[]> {
    const res = await getHistory(server.baseUrl, ALICE.rawKey, id);
    expect(res.status, `history failed: ${JSON.stringify(res.body)}`).toBe(200);
    return (res.body as HistoryResponse).transitions;
  }

  it("fail_times: 1 fails once, retries, and reaches ready with a coherent journal", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;

    const task = await submitTask({ duration_ms: SHORT_MS, fail_times: 1 });
    // The submitted value survives normalization untouched, next to the
    // duration — retries re-read the SAME params, which is what makes the
    // recovery deterministic rather than a coin flip.
    expect(task.params.fail_times).toBe(1);

    // A retryable failure first…
    const retrying = await cap.waitFor(
      (e) => e.type === "retrying" && e.task_id === task.id,
      T_JOB(SHORT_MS),
      `retrying for ${task.handle}`,
      server
    );
    expect(retrying.reason, "retrying event names the mechanism").toBe(flakyReason(1, 1));

    // …then success, with no `failed` event anywhere in between.
    await cap.waitFor(
      (e) => e.type === "ready" && e.task_id === task.id,
      T_RETRY_CHAIN,
      `ready for ${task.handle}`,
      server
    );
    expect(
      cap.all().some((e) => e.type === "failed" && e.task_id === task.id),
      "a recovered task must never emit `failed`"
    ).toBe(false);

    const after = await getTask(server.baseUrl, ALICE.rawKey, task.handle);
    expect(after.status).toBe(200);
    const final = after.body as TaskObject;
    expect(final.status, "final status").toBe("ready");
    expect(final.attempts, "succeeded on attempt 2").toBe(2);
    expect(final.error, "a ready task carries no error").toBeNull();
    expect((final.result as { slept_ms: number }).slept_ms).toBe(SHORT_MS);

    // The journal: accepted, running(1), retrying(1), running(2), ready.
    const transitions = await history(task.id);
    expect(
      transitions.map((t) => t.event_type),
      "event sequence"
    ).toEqual(["accepted", "running", "retrying", "running", "ready"]);

    const runs = transitions.filter((t) => t.event_type === "running");
    expect(runs.map((t) => t.meta.attempt), "journalled attempt numbers").toEqual([1, 2]);
    expect(runs.map((t) => t.meta.max_attempts), "journalled budget").toEqual([3, 3]);

    // The cross-check that makes `ctx.attempt` observable from outside: the
    // worker's own reason text names attempt 1, and the engine journalled
    // attempt 1 for the claim that produced it.
    const retryHop = transitions.find((t) => t.event_type === "retrying");
    expect(retryHop?.meta.reason, "retrying meta reason").toBe(flakyReason(1, 1));
    expect(retryHop?.meta.attempt, "retrying meta attempt").toBe(1);

    cap.close();
  });

  it("fail_times: 2 fails twice and succeeds on the third attempt", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;

    const task = await submitTask({ duration_ms: SHORT_MS, fail_times: 2 });

    await cap.waitForCount(
      (e) => e.type === "retrying" && e.task_id === task.id,
      2,
      T_RETRY_CHAIN,
      server
    );
    await cap.waitFor(
      (e) => e.type === "ready" && e.task_id === task.id,
      T_RETRY_CHAIN,
      `ready for ${task.handle}`,
      server
    );

    const transitions = await history(task.id);
    expect(transitions.map((t) => t.event_type)).toEqual([
      "accepted",
      "running",
      "retrying",
      "running",
      "retrying",
      "running",
      "ready",
    ]);
    // Each failure names its own attempt number — the reason text is honest
    // per attempt, not a fixed string.
    expect(
      transitions.filter((t) => t.event_type === "retrying").map((t) => t.meta.reason)
    ).toEqual([flakyReason(1, 2), flakyReason(2, 2)]);

    const final = (await getTask(server.baseUrl, ALICE.rawKey, task.handle)).body as TaskObject;
    expect(final.status).toBe("ready");
    expect(final.attempts, "succeeded on attempt 3, the last one in budget").toBe(3);

    cap.close();
  });

  it("fail_times at or above the attempt budget exhausts it and lands in failed", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;

    // Budget 2, scheduled to fail 3 times: the task can never reach the
    // attempt that would have succeeded.
    const task = await submitTask({ duration_ms: SHORT_MS, fail_times: 3 }, 2);

    const failed = await cap.waitFor(
      (e) => e.type === "failed" && e.task_id === task.id,
      T_RETRY_CHAIN,
      `failed for ${task.handle}`,
      server
    );
    expect(failed.reason, "the last attempt's reason is what surfaces").toBe(flakyReason(2, 3));

    const final = (await getTask(server.baseUrl, ALICE.rawKey, task.handle)).body as TaskObject;
    expect(final.status).toBe("failed");
    expect(final.attempts).toBe(2);
    expect(final.max_attempts).toBe(2);
    // Retryable — the budget ran out, not the possibility of success. That
    // distinction is what makes the operator-retry offer honest.
    expect(final.error).toEqual({ reason: flakyReason(2, 3), retryable: true });
    expect(final.result).toBeNull();

    const transitions = await history(task.id);
    expect(transitions.map((t) => t.event_type)).toEqual([
      "accepted",
      "running",
      "retrying",
      "running",
      "failed",
    ]);

    cap.close();
  });

  it("fail_permanent wins over fail_times; fail wins over fail_times", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;

    // fail_permanent: straight to `failed` on attempt 1, budget ignored.
    const permanent = await submitTask(
      { duration_ms: SHORT_MS, fail_times: 1, fail_permanent: true },
      3
    );
    const permanentEvent = await cap.waitFor(
      (e) => e.type === "failed" && e.task_id === permanent.id,
      T_JOB(SHORT_MS),
      `failed for ${permanent.handle}`,
      server
    );
    expect(permanentEvent.reason).toBe(
      "mock permanent failure requested via params.fail_permanent"
    );
    const permanentFinal = (await getTask(server.baseUrl, ALICE.rawKey, permanent.handle))
      .body as TaskObject;
    expect(permanentFinal.attempts, "no auto-retry at all").toBe(1);
    expect(permanentFinal.error?.retryable).toBe(false);

    // fail: retryable, and it keeps failing on every attempt — so a
    // fail_times that would have recovered never gets the chance.
    const always = await submitTask({ duration_ms: SHORT_MS, fail_times: 1, fail: true }, 2);
    const alwaysEvent = await cap.waitFor(
      (e) => e.type === "failed" && e.task_id === always.id,
      T_RETRY_CHAIN,
      `failed for ${always.handle}`,
      server
    );
    expect(alwaysEvent.reason).toBe("mock failure requested via params.fail");
    const alwaysFinal = (await getTask(server.baseUrl, ALICE.rawKey, always.handle))
      .body as TaskObject;
    expect(alwaysFinal.status).toBe("failed");
    expect(alwaysFinal.attempts).toBe(2);

    cap.close();
  });

  it("fail_times is validated at submit: integer 1-9, else 400 invalid_params", async () => {
    for (const value of [0, 10, -1, 1.5, "1", true, null]) {
      const res = await submit(server.baseUrl, ALICE.rawKey, {
        lane: "scrape",
        params: { duration_ms: 1000, fail_times: value },
      });
      expect(res.status, `fail_times=${JSON.stringify(value)}`).toBe(400);
      expect((res.body as ErrorEnvelope).error.code).toBe("invalid_params");
    }

    for (const value of [1, 9]) {
      const res = await submit(server.baseUrl, ALICE.rawKey, {
        lane: "scrape",
        params: { duration_ms: 1000, fail_times: value },
      });
      expect(res.status, `fail_times=${value}`).toBe(201);
      expect((res.body as TaskObject).params.fail_times).toBe(value);
    }
  });

  it("a submit with only duration_ms still succeeds deterministically", async () => {
    // The load-bearing negative: adding a flaky OUTCOME param must not make
    // the DEFAULT outcome flaky. Randomness is a client-side dice roll that
    // produces explicit params; the server never rolls one.
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;

    for (let i = 0; i < 5; i++) {
      const task = await submitTask({ duration_ms: SHORT_MS });
      expect(task.params.fail_times, "no outcome param is invented").toBeUndefined();
      await cap.waitFor(
        (e) => e.type === "ready" && e.task_id === task.id,
        T_JOB(SHORT_MS),
        `ready for ${task.handle}`,
        server
      );
    }
    expect(
      cap.all().filter((e) => e.type === "failed" || e.type === "retrying"),
      "no failure or retry anywhere in five clean submits"
    ).toEqual([]);

    // And a plain accepted event was seen for each, promptly.
    expect(cap.all().filter((e) => e.type === "accepted").length).toBe(5);
    await cap.waitFor((e) => e.type === "ready", T_EVENT, "at least one ready", server);

    cap.close();
  });
});
