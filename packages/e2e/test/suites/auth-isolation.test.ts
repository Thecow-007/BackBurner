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
  health,
  listTasks,
  request,
  resetDatabase,
  retry,
  settle,
  spawnServer,
  stopServer,
  submit,
  type ErrorEnvelope,
  type ServerHandle,
  type TaskListResponse,
  type TaskObject,
} from "../../src/index.js";

/**
 * Supplemental suite 5.1 — auth and cross-user isolation (test-plan.md §5.1;
 * api-contract.md §2). Every non-`/health` route requires a valid bearer key;
 * `?api_key=` is accepted on `/events` only; handle namespaces and event
 * streams are strictly per-user, and another user's handle is a `404`, never a
 * `403` (never an existence oracle).
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
describe("auth-isolation", () => {
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

  it("rejects missing, malformed, and unknown keys on /tasks* with a 401 unauthorized envelope", async () => {
    const b = server.baseUrl;
    const zeros = "bb_" + "0".repeat(40); // well-formed but unknown

    const cases: Array<{ label: string; opts: Parameters<typeof request>[1] }> = [
      { label: "no header on GET /tasks", opts: { path: "/tasks" } },
      { label: "Basic scheme", opts: { path: "/tasks", headers: { Authorization: "Basic Zm9vOmJhcg==" } } },
      { label: "empty Bearer", opts: { path: "/tasks", headers: { Authorization: "Bearer " } } },
      { label: "unknown key on GET /tasks", opts: { path: "/tasks", key: zeros } },
      { label: "no header on POST /tasks", opts: { method: "POST", path: "/tasks", body: { lane: "scrape" } } },
      { label: "unknown key on GET /tasks/{handle}", opts: { path: "/tasks/scrape-1", key: zeros } },
      { label: "unknown key on POST cancel", opts: { method: "POST", path: "/tasks/scrape-1/cancel", key: zeros } },
    ];

    for (const c of cases) {
      const res = await request<ErrorEnvelope>(b, c.opts);
      expect(res.status, c.label).toBe(401);
      expect(res.body.error.code, c.label).toBe("unauthorized");
    }
  });

  it("requires a valid key on /events and lets a present Authorization header win over ?api_key=", async () => {
    const b = server.baseUrl;
    const zeros = "bb_" + "0".repeat(40);

    // Missing key entirely.
    expect((await request<ErrorEnvelope>(b, { path: "/events" })).status).toBe(401);

    // Wrong ?api_key=.
    const wrong = await request<ErrorEnvelope>(b, { path: "/events", query: { api_key: zeros } });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("unauthorized");

    // Malformed Authorization header + a valid ?api_key=: the header is present,
    // so it wins, and being malformed it is a 401 (api-contract §2). This
    // request closes immediately (401), so request()'s body read never hangs on
    // an open stream.
    const headerWins = await request<ErrorEnvelope>(b, {
      path: "/events",
      query: { api_key: ALICE.rawKey },
      headers: { Authorization: "Bearer " },
    });
    expect(headerWins.status).toBe(401);
    expect(headerWins.body.error.code).toBe("unauthorized");
  });

  it("does not accept ?api_key= on any endpoint other than /events", async () => {
    // GET /tasks with no header but a valid ?api_key= is still unauthorized.
    const res = await request<ErrorEnvelope>(server.baseUrl, { path: "/tasks", query: { api_key: ALICE.rawKey } });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("serves GET /health with no auth", async () => {
    const res = await health(server.baseUrl);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("scopes lists and handle namespaces per user; another user's handle is 404", async () => {
    const b = server.baseUrl;

    // Alice owns scrape-1.
    const a = await submit(b, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 10000 } });
    expect(a.status).toBe(201);
    expect((a.body as TaskObject).handle).toBe("scrape-1");

    // Bob sees nothing — no leakage.
    const bobList = await listTasks(b, BOB.rawKey);
    expect(bobList.status).toBe(200);
    expect((bobList.body as TaskListResponse).tasks).toEqual([]);

    // Bob's own scrape-1 simply does not exist: 404 on every handle route,
    // never 403 (api-contract §2 — no existence oracle).
    const routes: Array<[string, () => Promise<{ status: number; body: unknown }>]> = [
      ["get", () => getTask(b, BOB.rawKey, "scrape-1")],
      ["result", () => collect(b, BOB.rawKey, "scrape-1")],
      ["cancel", () => cancel(b, BOB.rawKey, "scrape-1")],
      ["retry", () => retry(b, BOB.rawKey, "scrape-1")],
    ];
    for (const [label, call] of routes) {
      const res = await call();
      expect(res.status, label).toBe(404);
      expect((res.body as ErrorEnvelope).error.code, label).toBe("not_found");
    }

    // Alice still sees exactly her task.
    const aliceList = await listTasks(b, ALICE.rawKey);
    expect((aliceList.body as TaskListResponse).tasks.map((t) => t.handle)).toEqual(["scrape-1"]);
  });

  it("never leaks one user's events onto another user's stream", async () => {
    const b = server.baseUrl;

    // Bob is listening before anyone submits.
    const bobEvents = new EventCapture(b, BOB.rawKey, { server });
    await bobEvents.ready;

    // Alice submits and runs a job to completion on her own stream.
    const aliceRes = await submit(b, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 500 } });
    const aliceTaskId = (aliceRes.body as TaskObject).id;

    // Bob submits his own job; his stream must carry HIS accepted then ready.
    const bobRes = await submit(b, BOB.rawKey, { lane: "scrape", params: { duration_ms: 500 } });
    const bobTaskId = (bobRes.body as TaskObject).id;

    await bobEvents.waitFor(
      (e) => e.type === "accepted" && e.task_id === bobTaskId,
      T_EVENT,
      `bob accepted (task_id=${bobTaskId})`,
      server
    );

    // Sentinel = Bob's own `ready`. After it plus the settle window, assert
    // Bob's stream never carried a single event for Alice's task.
    await bobEvents.assertNever((e) => e.task_id === aliceTaskId, {
      sentinel: (e) => e.type === "ready" && e.task_id === bobTaskId,
      sentinelTimeoutMs: T_JOB(500),
      settleMs: T_SETTLE,
      server,
    });

    bobEvents.close();
  });
});
