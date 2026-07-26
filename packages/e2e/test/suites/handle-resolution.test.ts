import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ALICE,
  BOB,
  EventCapture,
  T_EVENT,
  T_JOB,
  collect,
  getById,
  getHistory,
  getTask,
  resetDatabase,
  settle,
  spawnServer,
  stopServer,
  submit,
  type ErrorEnvelope,
  type HistoryResponse,
  type ServerHandle,
  type TaskObject,
} from "../../src/index.js";

/**
 * Supplemental suite 5.4 — handle resolution (test-plan.md §5.4; api-contract.md
 * §5 "active holder wins, else most recent former holder, else 404", §6.7-§6.8
 * the `id`/`history` extension endpoints). Handles recycle; `id` never does
 * (CLAUDE.md) — this suite proves the resolution rule end-to-end: a
 * just-collected task is still reachable by its old handle until a new task
 * claims it, the stable `id` route survives recycling regardless, the history
 * endpoint replays the full transition sequence, finished-but-uncollected
 * `failed` tasks hold their handle exactly like `ready` ones, and unresolvable
 * handles (never allocated, unknown lane, malformed grammar) are all a plain
 * `404 not_found`.
 *
 * ── Canonical supplemental-suite lifecycle (test-plan.md §3.1-§3.2) ──
 * One server per FILE (spawned in `beforeAll`, stopped in `afterAll`) — unlike
 * the criteria suite's fresh-server-per-test. Between tests, `settle()` cancels
 * every `queued`/`running` task through the API so the worker pool is provably
 * idle (aborting long jobs frees their in-memory slots), and only THEN is the
 * database truncated. `settle()` needs a live per-user `EventCapture` to await
 * the `cancelled` events it triggers. All other supplemental suites follow this
 * exact shape.
 */
describe("handle-resolution", () => {
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
    // Drain in-flight work for both actors before the next truncation. A
    // short-lived per-user capture lets settle() await the cancelled events.
    for (const user of [ALICE, BOB]) {
      const cap = new EventCapture(server.baseUrl, user.rawKey, { server });
      await cap.ready;
      await settle(server.baseUrl, user.rawKey, cap, { server });
      cap.close();
    }
  });

  it("still resolves GET /tasks/{handle} to the collected former holder right after collecting it", async () => {
    const b = server.baseUrl;
    const cap = new EventCapture(b, ALICE.rawKey, { server });
    await cap.ready;

    const submitRes = await submit(b, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 300 } });
    expect(submitRes.status).toBe(201);
    const task = submitRes.body as TaskObject;
    expect(task.handle).toBe("scrape-1");

    await cap.waitFor(
      (e) => e.type === "ready" && e.task_id === task.id,
      T_JOB(300),
      `ready for scrape-1 (task_id=${task.id})`,
      server
    );

    const collectRes = await collect(b, ALICE.rawKey, "scrape-1");
    expect(collectRes.status).toBe(200);
    const collected = collectRes.body as TaskObject;
    expect(collected.id).toBe(task.id);
    expect(collected.collected).toBe(true);

    // No new scrape has been submitted yet, so scrape-1 has no active
    // holder — resolution falls through to the most recent former holder,
    // letting a reviewer inspect the task right after collecting it.
    const getRes = await getTask(b, ALICE.rawKey, "scrape-1");
    expect(getRes.status).toBe(200);
    const resolved = getRes.body as TaskObject;
    expect(resolved.id).toBe(task.id);
    expect(resolved.status).toBe("ready");
    expect(resolved.collected).toBe(true);

    cap.close();
  });

  it("resolves GET /tasks/{handle} to the new active holder after recycling, while GET /tasks/id/{id} keeps the old task's original data", async () => {
    const b = server.baseUrl;
    const cap = new EventCapture(b, ALICE.rawKey, { server });
    await cap.ready;

    // First scrape-1: run to ready, collect it, freeing the handle.
    const firstRes = await submit(b, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 300 } });
    expect(firstRes.status).toBe(201);
    const first = firstRes.body as TaskObject;
    expect(first.handle).toBe("scrape-1");

    await cap.waitFor(
      (e) => e.type === "ready" && e.task_id === first.id,
      T_JOB(300),
      `ready for first scrape-1 (task_id=${first.id})`,
      server
    );

    const firstCollectRes = await collect(b, ALICE.rawKey, "scrape-1");
    expect(firstCollectRes.status).toBe(200);

    // Submit a new scrape: it reuses the freed scrape-1 number under a
    // brand-new id.
    const secondRes = await submit(b, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 10000 } });
    expect(secondRes.status).toBe(201);
    const second = secondRes.body as TaskObject;
    expect(second.handle).toBe("scrape-1");
    expect(second.id).not.toBe(first.id);

    // GET /tasks/scrape-1 now resolves to the ACTIVE holder (the new task),
    // not the collected former holder.
    const getRes = await getTask(b, ALICE.rawKey, "scrape-1");
    expect(getRes.status).toBe(200);
    const resolved = getRes.body as TaskObject;
    expect(resolved.id).toBe(second.id);
    expect(["queued", "running"]).toContain(resolved.status);

    // The old task remains reachable, unchanged, at its stable id — the
    // extension endpoint that survives recycling.
    const oldRes = await getById(b, ALICE.rawKey, first.id);
    expect(oldRes.status).toBe(200);
    const old = oldRes.body as TaskObject;
    expect(old.id).toBe(first.id);
    expect(old.handle).toBe("scrape-1");
    expect(old.status).toBe("ready");
    expect(old.collected).toBe(true);

    cap.close();
  });

  it("GET /tasks/id/{id}/history returns the ordered transitions for a completed, collected task", async () => {
    const b = server.baseUrl;
    const cap = new EventCapture(b, ALICE.rawKey, { server });
    await cap.ready;

    const submitRes = await submit(b, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 300 } });
    expect(submitRes.status).toBe(201);
    const task = submitRes.body as TaskObject;
    expect(task.handle).toBe("scrape-1");

    await cap.waitFor(
      (e) => e.type === "ready" && e.task_id === task.id,
      T_JOB(300),
      `ready for scrape-1 (task_id=${task.id})`,
      server
    );

    const collectRes = await collect(b, ALICE.rawKey, "scrape-1");
    expect(collectRes.status).toBe(200);

    const historyRes = await getHistory(b, ALICE.rawKey, task.id);
    expect(historyRes.status).toBe(200);
    const { transitions } = historyRes.body as HistoryResponse;

    expect(transitions.map((t) => t.event_type)).toEqual(["accepted", "running", "ready", "collected"]);

    expect(transitions).toHaveLength(4);
    const accepted = transitions[0]!;
    const running = transitions[1]!;
    const ready = transitions[2]!;
    const collectedTransition = transitions[3]!;
    expect(accepted.from_status).toBeNull();
    expect(accepted.to_status).toBe("queued");
    expect(running.from_status).toBe("queued");
    expect(running.to_status).toBe("running");
    expect(ready.from_status).toBe("running");
    expect(ready.to_status).toBe("ready");
    // `collected` records the flag flip, not a status change: ready -> ready.
    expect(collectedTransition.from_status).toBe("ready");
    expect(collectedTransition.to_status).toBe("ready");

    // Every transition carries a real, monotonically non-decreasing timestamp.
    const times = transitions.map((t) => Date.parse(t.at));
    for (const t of times) {
      expect(Number.isNaN(t)).toBe(false);
    }
    for (let i = 1; i < times.length; i++) {
      expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
    }

    cap.close();
  });

  it("failed tasks hold their handle until collected, then free it for reuse", async () => {
    const b = server.baseUrl;
    const cap = new EventCapture(b, ALICE.rawKey, { server });
    await cap.ready;

    // Drive scrape-1 to failed: a single fast attempt (max_attempts: 1)
    // makes the failure both deterministic and quick.
    const firstRes = await submit(b, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: 300, fail: true },
      max_attempts: 1,
    });
    expect(firstRes.status).toBe(201);
    const first = firstRes.body as TaskObject;
    expect(first.handle).toBe("scrape-1");

    await cap.waitFor(
      (e) => e.type === "failed" && e.task_id === first.id,
      T_JOB(300),
      `failed for scrape-1 (task_id=${first.id})`,
      server
    );

    // scrape-1 is finished-but-uncollected — still ACTIVE. A new scrape must
    // get scrape-2, never reuse the still-held scrape-1 (the load-bearing
    // "active includes finished-but-uncollected failed" rule).
    const secondRes = await submit(b, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 10000 } });
    expect(secondRes.status).toBe(201);
    const second = secondRes.body as TaskObject;
    expect(second.handle).toBe("scrape-2");

    // Collect the failed scrape-1: full task object, collected:true, error populated.
    const collectRes = await collect(b, ALICE.rawKey, "scrape-1");
    expect(collectRes.status).toBe(200);
    const collected = collectRes.body as TaskObject;
    expect(collected.id).toBe(first.id);
    expect(collected.status).toBe("failed");
    expect(collected.collected).toBe(true);
    expect(collected.attempts).toBe(1);
    expect(collected.error).toEqual({
      reason: "mock failure requested via params.fail",
      retryable: true,
    });

    // The collect call emits a `collected` event on the stream.
    await cap.waitFor(
      (e) => e.type === "collected" && e.task_id === first.id,
      T_EVENT,
      `collected for scrape-1 (task_id=${first.id})`,
      server
    );

    // scrape-1 is now freed: a third submit reuses it, under a fresh id.
    const thirdRes = await submit(b, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 10000 } });
    expect(thirdRes.status).toBe(201);
    const third = thirdRes.body as TaskObject;
    expect(third.handle).toBe("scrape-1");
    expect(third.id).not.toBe(first.id);

    cap.close();
  });

  it("returns 404 not_found for never-allocated, unknown-lane, and malformed handles", async () => {
    const b = server.baseUrl;

    // scrape-99: well-formed, never allocated. nosuch-1: unknown lane.
    // scrape / scrape-0 / scrape--1 / scrape-01: fail the canonical grammar
    // `^(lane)-([1-9][0-9]*)$` — no handle body, zero, a double-dash split,
    // and a leading zero are all unparseable (api-contract §5).
    const handles = ["scrape-99", "nosuch-1", "scrape", "scrape-0", "scrape--1", "scrape-01"];

    for (const handle of handles) {
      const res = await getTask(b, ALICE.rawKey, handle);
      expect(res.status, handle).toBe(404);
      expect((res.body as ErrorEnvelope).error.code, handle).toBe("not_found");
    }
  });
});
