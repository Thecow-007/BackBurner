import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ALICE,
  EventCapture,
  listTasks,
  resetDatabase,
  settle,
  spawnServer,
  stopServer,
  submit,
  type ErrorEnvelope,
  type ListQuery,
  type ServerHandle,
  type TaskListResponse,
  type TaskObject,
} from "../../src/index.js";

/**
 * Supplemental suite 5.13 — the lane registry and its per-lane defaults
 * (api-contract.md §1 "Registered lanes", §6.2's `lane_defaults`, ADR 0021).
 *
 * Five lanes are registered, all backed by the mock worker, and the
 * registration ORDER is contract: it is what `counts.lanes` reports and
 * therefore the order the dashboard's sidebar and submit picker render.
 *
 * `build` is the long-running lane: an omitted `params.duration_ms` is drawn
 * from 20000-90000 ms instead of the usual 3000-15000. The mechanism is
 * untouched (ADR 0017) — the value is still resolved once, at submit time,
 * and written into the stored params — only the range is per-lane. That is
 * exactly why `lane_defaults` exists: a submit form must be able to state a
 * lane's real range instead of hard-coding one it cannot source
 * (frontend-brief §6.5).
 *
 * ── Canonical supplemental-suite lifecycle (test-plan.md §3.1-§3.2) ──
 * One server per FILE, `settle()` + truncate between tests. Tasks submitted
 * here run for tens of seconds by design, so `settle()` is what keeps the
 * pool from carrying work across tests.
 */
describe("lane-registry", () => {
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

  /** Registration order — normative (api-contract §1). */
  const REGISTERED_LANES = ["scrape", "report", "convert", "build", "test"] as const;
  const DEFAULT_RANGE = { min: 3000, max: 15000 };
  const LONG_RANGE = { min: 20000, max: 90000 };

  async function submitTo(lane: string, params: Record<string, unknown> = {}): Promise<TaskObject> {
    const res = await submit(server.baseUrl, ALICE.rawKey, { lane, params });
    expect(res.status, `submit ${lane}: ${JSON.stringify(res.body)}`).toBe(201);
    return res.body as TaskObject;
  }

  async function list(query: ListQuery = {}): Promise<TaskListResponse> {
    const res = await listTasks(server.baseUrl, ALICE.rawKey, { limit: 200, ...query });
    expect(res.status, `GET /tasks ${JSON.stringify(query)}`).toBe(200);
    return res.body as TaskListResponse;
  }

  it("registers exactly five lanes, in order, and every one accepts a submit", async () => {
    const empty = await list();
    expect(empty.counts.lanes, "registration order is contract").toEqual([...REGISTERED_LANES]);

    for (const lane of REGISTERED_LANES) {
      const task = await submitTo(lane, { duration_ms: 20000 });
      // Numbering is per lane, so each lane's first task is `<lane>-1`.
      expect(task.handle, `${lane} handle`).toBe(`${lane}-1`);
      expect(task.lane).toBe(lane);
    }

    const after = await list();
    expect(after.counts.all).toBe(REGISTERED_LANES.length);
    for (const lane of REGISTERED_LANES) {
      expect(after.counts.lane[lane], `lane.${lane}`).toBe(1);
    }

    // An unregistered lane is still rejected — five lanes, not "any lane".
    const bad = await submit(server.baseUrl, ALICE.rawKey, { lane: "deploy" });
    expect(bad.status).toBe(400);
    expect((bad.body as ErrorEnvelope).error.code).toBe("unknown_lane");
  });

  it("counts.lane_defaults states each lane's real omitted-duration range", async () => {
    const body = await list();

    expect(body.counts.lane_defaults).toEqual({
      scrape: { duration_ms: DEFAULT_RANGE },
      report: { duration_ms: DEFAULT_RANGE },
      convert: { duration_ms: DEFAULT_RANGE },
      build: { duration_ms: LONG_RANGE },
      test: { duration_ms: DEFAULT_RANGE },
    });
    // One entry per registered lane, in the same order — the submit picker
    // reads both together and must not have to sort them itself.
    expect(Object.keys(body.counts.lane_defaults)).toEqual(body.counts.lanes);

    // Filter-invariant, like `lanes`: it is registry metadata, not data.
    await submitTo("scrape", { duration_ms: 20000 });
    const filtered = await list({ lane: "build", status: "queued" });
    expect(filtered.counts.lane_defaults).toEqual(body.counts.lane_defaults);
  });

  it("an omitted duration_ms is drawn from the lane's own range and written into stored params", async () => {
    const SAMPLES = 6;

    // `build` — the long lane. Every draw must be inside 20000-90000, which
    // is disjoint from the 3000-15000 every other lane uses, so a lane mix-up
    // cannot hide behind an overlapping range.
    const builds: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const task = await submitTo("build");
      const d = task.params.duration_ms as number;
      expect(Number.isInteger(d), `build duration ${d} is an integer`).toBe(true);
      expect(d, `build duration ${d} >= ${LONG_RANGE.min}`).toBeGreaterThanOrEqual(LONG_RANGE.min);
      expect(d, `build duration ${d} <= ${LONG_RANGE.max}`).toBeLessThanOrEqual(LONG_RANGE.max);
      builds.push(d);
    }
    // Resolved ONCE at submit and stored: the value the list echoes is the
    // same value the creation response carried, not a fresh roll per read.
    const listed = await list({ lane: "build" });
    const listedDurations = listed.tasks.map((t) => t.params.duration_ms as number).sort();
    expect(listedDurations).toEqual([...builds].sort());

    for (const lane of ["scrape", "report", "convert", "test"] as const) {
      const task = await submitTo(lane);
      const d = task.params.duration_ms as number;
      expect(d, `${lane} duration ${d} >= ${DEFAULT_RANGE.min}`).toBeGreaterThanOrEqual(
        DEFAULT_RANGE.min
      );
      expect(d, `${lane} duration ${d} <= ${DEFAULT_RANGE.max}`).toBeLessThanOrEqual(
        DEFAULT_RANGE.max
      );
    }
  });

  it("an explicit duration_ms is honoured on the long lane too", async () => {
    const task = await submitTo("build", { duration_ms: 1234 });
    expect(task.params.duration_ms).toBe(1234);

    // …and the extra-params pass-through still holds on every lane.
    const withExtras = await submitTo("test", { duration_ms: 20000, custom: "x" });
    expect(withExtras.params).toEqual({ duration_ms: 20000, custom: "x" });
  });
});
