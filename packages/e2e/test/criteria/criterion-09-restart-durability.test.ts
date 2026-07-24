import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ALICE,
  EventCapture,
  killServer,
  listTasks,
  resetDatabase,
  spawnServer,
  stopServer,
  submit,
  T_EVENT,
  T_SETTLE,
  T_WAVES,
  type CapturedEvent,
  type ServerHandle,
  type TaskListResponse,
  type TaskObject,
} from "../../src/index.js";

/**
 * criterion-09-restart-durability (test-plan.md §4.9).
 *
 * Spec: "Durability across restart. Submit several jobs so some are running
 * and some queued, kill the backend process, and restart it. `GET /tasks`
 * still shows every job with its correct status; in-flight work is resumed
 * or cleanly re-queued; nothing is lost. This and the no-collision check are
 * the two we verify most carefully."
 *
 * This is the most intricate test in the suite (test-plan.md §4.9's own
 * framing): the interrupted pair is identified by *snapshot status*, never
 * submission order; the interrupted pair's attempt count is
 * status-conditional at the immediate post-restart snapshot (`attempts===1`
 * while `queued`, `attempts===2` once `running`) because recovery's final
 * `dispatch()` may or may not have already re-claimed it by the time
 * `BACKBURNER_READY` prints; the deterministic attempt-count check
 * (`attempts===2` for the interrupted pair, `attempts===1` for the other
 * three) only holds *after* completion; and the recovery `retrying` events
 * carry `recovery: true` as a **top-level** SSE field, never under a `meta`
 * wrapper (that belongs only to the history endpoint).
 */
describe("criterion-09-restart-durability", () => {
  let server1: ServerHandle | undefined;
  let server2: ServerHandle | undefined;
  let events1: EventCapture | undefined;
  let events2: EventCapture | undefined;

  beforeEach(async () => {
    await resetDatabase();
    server1 = await spawnServer({ WORKER_CONCURRENCY: "2" });
  });

  afterEach(async () => {
    if (events1) events1.close();
    if (events2) events2.close();
    // Teardown must be robust to an already-dead server #1 (killServer /
    // stopServer are both idempotent no-ops on an exited process) and must
    // not fail if beforeEach itself failed before server1 was assigned.
    if (server1) await stopServer(server1);
    if (server2) await stopServer(server2);
  });

  it("resumes in-flight work and re-queues cleanly across a hard kill and restart", async () => {
    const s1 = server1;
    if (!s1) throw new Error("server #1 was not spawned");

    // ES connected to server #1 before the first submit (test-plan.md §4 intro).
    events1 = new EventCapture(s1.baseUrl, ALICE.rawKey, { server: s1 });
    await events1.ready;
    const ec1 = events1;

    // Step 1: submit 5 scrape jobs A–E, duration_ms: 8000 each.
    const [rA, rB, rC, rD, rE] = await Promise.all([
      submit(s1.baseUrl, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 8000 } }),
      submit(s1.baseUrl, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 8000 } }),
      submit(s1.baseUrl, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 8000 } }),
      submit(s1.baseUrl, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 8000 } }),
      submit(s1.baseUrl, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 8000 } }),
    ]);
    const submissions = [rA, rB, rC, rD, rE];
    for (const r of submissions) {
      expect(r.status).toBe(201);
    }
    const bodies = submissions.map((r) => r.body as TaskObject);
    const taskIds = new Set(bodies.map((b) => b.id));
    expect(taskIds.size).toBe(5);

    // Two jobs in flight, three queued (WORKER_CONCURRENCY=2).
    await ec1.waitForCount(
      (e) => e.type === "running" && taskIds.has(e.task_id),
      2,
      T_EVENT,
      s1
    );

    // Step 2: pre-kill snapshot — record every task_id, handle, status, and
    // as_of. Expect exactly 2 running, 3 queued. The interrupted pair is
    // identified by snapshot status, never submission order.
    const preKillRes = await listTasks(s1.baseUrl, ALICE.rawKey);
    expect(preKillRes.status).toBe(200);
    const preKill = preKillRes.body as TaskListResponse;
    expect(preKill.tasks).toHaveLength(5);

    const preKillRunning = preKill.tasks.filter((t) => t.status === "running");
    const preKillQueued = preKill.tasks.filter((t) => t.status === "queued");
    expect(preKillRunning).toHaveLength(2);
    expect(preKillQueued).toHaveLength(3);

    const interruptedIds = new Set(preKillRunning.map((t) => t.id));
    const preKillByTaskId = new Map(preKill.tasks.map((t) => [t.id, t]));
    const asOf = preKill.as_of;

    // Step 3: killServer (SIGKILL / TerminateProcess) — no drain, no
    // goodbye. Await process exit; close the ES connection.
    await killServer(s1);
    ec1.close();

    // Step 4: spawn server #2 against the same DATABASE_URL (new random
    // port, same WORKER_CONCURRENCY so the dispatch-wave shape matches
    // T_WAVES). The ready line implies boot recovery has completed.
    server2 = await spawnServer({ WORKER_CONCURRENCY: "2" });
    const s2 = server2;

    // Step 5: immediately GET /tasks on server #2.
    const postKillRes = await listTasks(s2.baseUrl, ALICE.rawKey);
    expect(postKillRes.status).toBe(200);
    const postKill = postKillRes.body as TaskListResponse;

    // Exactly 5 tasks — same task_ids and same handles as the pre-kill
    // snapshot; nothing lost, nothing invented.
    expect(postKill.tasks).toHaveLength(5);
    const postKillTaskIds = new Set(postKill.tasks.map((t) => t.id));
    expect(postKillTaskIds).toEqual(taskIds);

    const postKillByTaskId = new Map(postKill.tasks.map((t) => [t.id, t]));
    for (const [taskId, preTask] of preKillByTaskId) {
      const postTask = postKillByTaskId.get(taskId);
      if (!postTask) throw new Error(`task ${taskId} missing from post-kill snapshot`);
      expect(postTask.handle).toBe(preTask.handle);
      // Every status ∈ {queued, running}: cleanly re-queued or already
      // re-claimed, never silently ready/failed/cancelled.
      expect(["queued", "running"]).toContain(postTask.status);
    }

    // The interrupted pair's attempt count is status-conditional:
    // attempts===1 while queued, attempts===2 once running.
    for (const taskId of interruptedIds) {
      const postTask = postKillByTaskId.get(taskId);
      if (!postTask) throw new Error(`interrupted task ${taskId} missing from post-kill snapshot`);
      if (postTask.status === "queued") {
        expect(postTask.attempts).toBe(1);
      } else {
        expect(postTask.status).toBe("running");
        expect(postTask.attempts).toBe(2);
      }
    }

    // Step 6: connect a new ES to server #2 with ?since=<as_of from step 2>.
    events2 = new EventCapture(s2.baseUrl, ALICE.rawKey, { since: asOf, server: s2 });
    await events2.ready;
    const ec2 = events2;

    // The recovery `retrying` events for the interrupted pair arrive with
    // the top-level field recovery: true, plus attempt/max_attempts
    // (api-contract §8) — no `meta` wrapper on SSE frames.
    const recoveryRetryingEvents = await ec2.waitForCount(
      (e) => e.type === "retrying" && interruptedIds.has(e.task_id) && e.recovery === true,
      2,
      T_EVENT,
      s2
    );
    expect(recoveryRetryingEvents).toHaveLength(2);
    const recoveredTaskIds = new Set(recoveryRetryingEvents.map((e) => e.task_id));
    expect(recoveredTaskIds).toEqual(interruptedIds);
    for (const e of recoveryRetryingEvents) {
      expect(e.recovery).toBe(true);
      expect(typeof e.attempt).toBe("number");
      expect(typeof e.max_attempts).toBe("number");
      // recovery is a top-level field, never nested under `meta` (that
      // shape belongs only to GET /tasks/id/{id}/history, per §4.9's own
      // wording).
      expect(e["meta"]).toBeUndefined();
    }

    // Step 7: wait for all 5 ready (recovery + 3 waves of 8s); the 5th
    // ready is the sentinel — keep capturing T_SETTLE more, as criterion 08
    // does.
    const readyEvents = await ec2.waitForCount(
      (e) => e.type === "ready" && taskIds.has(e.task_id),
      5,
      T_WAVES(3, 8000),
      s2
    );
    if (readyEvents.length !== 5) {
      throw new Error(`expected exactly 5 ready events, got ${readyEvents.length}`);
    }
    const fifthReady = readyEvents[4];
    if (!fifthReady) throw new Error("missing 5th ready event");

    // MUST NOT arrive on the server #2 stream, evaluated with the 5th ready
    // as sentinel plus the T_SETTLE tail: any failed or cancelled event.
    const forbidden = (e: CapturedEvent): boolean =>
      (e.type === "failed" || e.type === "cancelled") && taskIds.has(e.task_id);
    await ec2.assertNever(forbidden, {
      sentinel: (e) => e.id === fifthReady.id,
      sentinelTimeoutMs: T_EVENT,
      settleMs: T_SETTLE,
      server: s2,
    });

    // ...or a second ready for any task_id — judged against the final
    // buffer (post-settle).
    const finalReady = ec2.all().filter((e) => e.type === "ready" && taskIds.has(e.task_id));
    expect(finalReady).toHaveLength(5);
    const finalReadyTaskIds = new Set(finalReady.map((e) => e.task_id));
    expect(finalReadyTaskIds.size).toBe(5);

    // Final GET /tasks: 5 distinct task_ids, no duplicates; final statuses
    // all ready; the interrupted pair finish with attempts===2, the other
    // three with attempts===1 — the deterministic budget check lives here,
    // after completion, not at step 5.
    const finalListRes = await listTasks(s2.baseUrl, ALICE.rawKey);
    expect(finalListRes.status).toBe(200);
    const finalList = finalListRes.body as TaskListResponse;
    expect(finalList.tasks).toHaveLength(5);

    const finalByTaskId = new Map(finalList.tasks.map((t) => [t.id, t]));
    for (const taskId of taskIds) {
      const finalTask = finalByTaskId.get(taskId);
      if (!finalTask) throw new Error(`task ${taskId} missing from final snapshot`);
      expect(finalTask.status).toBe("ready");
      if (interruptedIds.has(taskId)) {
        expect(finalTask.attempts).toBe(2);
      } else {
        expect(finalTask.attempts).toBe(1);
      }
    }
  });
});
