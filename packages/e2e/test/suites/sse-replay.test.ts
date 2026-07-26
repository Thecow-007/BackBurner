import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ALICE,
  BOB,
  EventCapture,
  T_EVENT,
  T_JOB,
  cancel,
  listTasks,
  rawEventStream,
  request,
  resetDatabase,
  settle,
  spawnServer,
  stopServer,
  submit,
  type CapturedEvent,
  type ErrorEnvelope,
  type RawEventStreamHandle,
  type ServerHandle,
  type TaskListResponse,
  type TaskObject,
} from "../../src/index.js";

/**
 * Supplemental suite 5.5 — SSE replay and heartbeat (test-plan.md §5.5;
 * api-contract.md §7-§8). `?since`/`Last-Event-ID` catch-up, the `as_of`
 * snapshot-to-stream bridge, replay+live dedup, and the `: hb` heartbeat
 * comment that keeps idle connections alive.
 *
 * ── Canonical supplemental-suite lifecycle (test-plan.md §3.1-§3.2) ──
 * One server per FILE (spawned in `beforeAll`), except the heartbeat test,
 * which spawns its own short-lived server with a lowered
 * `SSE_HEARTBEAT_MS`. `settle()` drains ALICE's (and BOB's, for symmetry
 * with the canonical shape) in-flight work before each truncation.
 */
describe("sse-replay", () => {
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

  /**
   * Drives a known history for ALICE: two short jobs to `ready` plus one
   * longer job that is cancelled mid-flight, while a live `EventCapture`
   * (connected before the first submit) records every event id. Returns
   * that id sequence plus the three task ids, and closes the live capture.
   */
  async function driveHistory(): Promise<{
    ids: number[];
    taskIds: { a: string; b: string; c: string };
  }> {
    const live = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await live.ready;

    const a = await submit(server.baseUrl, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 500 } });
    const b = await submit(server.baseUrl, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 500 } });
    const c = await submit(server.baseUrl, ALICE.rawKey, { lane: "scrape", params: { duration_ms: 5000 } });
    const aId = (a.body as TaskObject).id;
    const bId = (b.body as TaskObject).id;
    const cId = (c.body as TaskObject).id;

    await live.waitFor(
      (e) => e.type === "ready" && e.task_id === aId,
      T_JOB(500),
      `driveHistory: job a ready (task_id=${aId})`,
      server
    );
    await live.waitFor(
      (e) => e.type === "ready" && e.task_id === bId,
      T_JOB(500),
      `driveHistory: job b ready (task_id=${bId})`,
      server
    );

    const cancelRes = await cancel(server.baseUrl, ALICE.rawKey, (c.body as TaskObject).handle);
    expect(cancelRes.status).toBe(200);
    await live.waitFor(
      (e) => e.type === "cancelled" && e.task_id === cId,
      T_EVENT,
      `driveHistory: job c cancelled (task_id=${cId})`,
      server
    );

    const ids = live.all().map((e) => e.id);
    live.close();
    return { ids, taskIds: { a: aId, b: bId, c: cId } };
  }

  /** Reads `id:`/`data:` line pairs off a raw stream until `count` events
   * have been assembled, ignoring blank separator lines and `: hb`
   * comments. Does not close `raw` — callers do that themselves. */
  async function collectRawEvents(raw: RawEventStreamHandle, count: number): Promise<CapturedEvent[]> {
    const events: CapturedEvent[] = [];
    let pendingId: number | undefined;
    for await (const line of raw.lines) {
      if (line.startsWith("id: ")) {
        pendingId = Number(line.slice("id: ".length));
      } else if (line.startsWith("data: ")) {
        const data = JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
        events.push({ ...(data as object), id: pendingId! } as CapturedEvent);
        pendingId = undefined;
        if (events.length >= count) break;
      }
    }
    return events;
  }

  it("since=0 replays the full per-user history, ids strictly increasing with no gaps or dupes", async () => {
    const { ids: liveIds } = await driveHistory();
    expect(liveIds.length).toBeGreaterThan(0);

    const replay = new EventCapture(server.baseUrl, ALICE.rawKey, { since: 0, server });
    await replay.ready;
    const replayed = await replay.waitForCount(() => true, liveIds.length, T_EVENT, server);
    replay.close();

    const replayedIds = replayed.map((e) => e.id);
    expect(replayedIds).toEqual(liveIds);
    for (let i = 1; i < replayedIds.length; i++) {
      expect(replayedIds[i]).toBeGreaterThan(replayedIds[i - 1]!);
    }
    expect(new Set(replayedIds).size).toBe(replayedIds.length);
  });

  it("since=<mid-stream id> replays exactly the events with id greater than mid, in order", async () => {
    const { ids: liveIds } = await driveHistory();
    const midIndex = Math.floor(liveIds.length / 2);
    const mid = liveIds[midIndex]!;
    const expectedIds = liveIds.filter((id) => id > mid);
    expect(expectedIds.length).toBeGreaterThan(0);

    const replay = new EventCapture(server.baseUrl, ALICE.rawKey, { since: mid, server });
    await replay.ready;
    const replayed = await replay.waitForCount(() => true, expectedIds.length, T_EVENT, server);
    replay.close();

    expect(replayed.map((e) => e.id)).toEqual(expectedIds);
  });

  it("a raw Last-Event-ID header replays the same set as ?since=<mid>, and wins when both are present", async () => {
    const { ids: liveIds } = await driveHistory();
    const midIndex = Math.floor(liveIds.length / 2);
    const mid = liveIds[midIndex]!;
    const expectedIds = liveIds.filter((id) => id > mid);
    expect(expectedIds.length).toBeGreaterThan(0);

    // Last-Event-ID header alone, no ?since=.
    const raw = await rawEventStream(server.baseUrl, {
      apiKeyQuery: ALICE.rawKey,
      headers: { "Last-Event-ID": String(mid) },
    });
    try {
      const collected = await collectRawEvents(raw, expectedIds.length);
      expect(collected.map((e) => e.id)).toEqual(expectedIds);
    } finally {
      raw.close();
    }

    // Both present, and pointing at different positions: the header (an
    // earlier-in-the-array id than mid, so a since-wins bug would under- or
    // over-replay relative to expectedIds) must win.
    const earlier = liveIds[0]!;
    const raw2 = await rawEventStream(server.baseUrl, {
      since: earlier,
      apiKeyQuery: ALICE.rawKey,
      headers: { "Last-Event-ID": String(mid) },
    });
    try {
      const collected2 = await collectRawEvents(raw2, expectedIds.length);
      expect(collected2.map((e) => e.id)).toEqual(expectedIds);
    } finally {
      raw2.close();
    }
  });

  it("since=abc is rejected with 400 invalid_params at connect time", async () => {
    const res = await request<ErrorEnvelope>(server.baseUrl, {
      path: "/events",
      query: { since: "abc" },
      headers: { Authorization: `Bearer ${ALICE.rawKey}` },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_params");
  });

  it("gap-free hydration: since=as_of catches a submit that happened right after the snapshot", async () => {
    const listRes = await listTasks(server.baseUrl, ALICE.rawKey);
    expect(listRes.status).toBe(200);
    const asOf = (listRes.body as TaskListResponse).as_of;

    const submitRes = await submit(server.baseUrl, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: 500 },
    });
    expect(submitRes.status).toBe(201);
    const taskId = (submitRes.body as TaskObject).id;

    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { since: asOf, server });
    await cap.ready;

    await cap.waitFor(
      (e) => e.type === "accepted" && e.task_id === taskId,
      T_EVENT,
      `gap-free hydration: accepted (task_id=${taskId})`,
      server
    );
    await cap.waitFor(
      (e) => e.type === "ready" && e.task_id === taskId,
      T_JOB(500),
      `gap-free hydration: ready (task_id=${taskId})`,
      server
    );

    cap.close();
  });

  it("replay + live seam: replayed and live events arrive deduplicated by id, strictly increasing", async () => {
    // Mid-flight job: its accepted/running are already committed (and thus
    // replayable) by the time the seam capture connects; its ready only
    // arrives live.
    const midFlight = await submit(server.baseUrl, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: 3000 },
    });
    const midFlightId = (midFlight.body as TaskObject).id;

    const seam = new EventCapture(server.baseUrl, ALICE.rawKey, { since: 0, server });
    await seam.ready;

    await seam.waitFor(
      (e) => e.type === "ready" && e.task_id === midFlightId,
      T_JOB(3000),
      `replay+live seam: ready (task_id=${midFlightId})`,
      server
    );

    const ids = seam.all().map((e) => e.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]!);
    }

    seam.close();
  });

  it("emits at least 2 heartbeat comment lines within ~2s while the connection stays open", async () => {
    const hb = await spawnServer({ SSE_HEARTBEAT_MS: "250" });
    try {
      const raw = await rawEventStream(hb.baseUrl, { apiKeyQuery: ALICE.rawKey });
      try {
        let hb2 = 0;
        const deadline = Date.now() + 2500;
        for await (const line of raw.lines) {
          if (line.trim() === ": hb") hb2++;
          if (hb2 >= 2 || Date.now() > deadline) break;
        }
        expect(hb2).toBeGreaterThanOrEqual(2);
      } finally {
        raw.close();
      }
    } finally {
      await stopServer(hb);
    }
  });
});
