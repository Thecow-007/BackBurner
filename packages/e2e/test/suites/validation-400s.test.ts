import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ALICE,
  BOB,
  EventCapture,
  getById,
  request,
  resetDatabase,
  settle,
  spawnServer,
  stopServer,
  submit,
  type ErrorEnvelope,
  type ServerHandle,
  type TaskObject,
} from "../../src/index.js";

/**
 * Supplemental suite 5.7 — validation 400s (test-plan.md §5.7; api-contract.md
 * §3, §6.1, §6.7). `POST /tasks` and `GET /tasks/id/{id}` reject malformed
 * input with the standard `{ error: { code, message } }` envelope; the one
 * exception is unknown keys *inside* `params`, which pass through untouched
 * (the free-form area is `params`, nothing else at the top level).
 *
 * ── Canonical supplemental-suite lifecycle (test-plan.md §3.1-§3.2) ──
 * One server per FILE (spawned in `beforeAll`, stopped in `afterAll`) —
 * unlike the criteria suite's fresh-server-per-test. Between tests, `settle()`
 * cancels every `queued`/`running` task through the API so the worker pool is
 * provably idle, and only THEN is the database truncated.
 */
describe("validation-400s", () => {
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

  function expectInvalidParams(res: { status: number; body: unknown }, label: string): void {
    expect(res.status, label).toBe(400);
    expect((res.body as ErrorEnvelope).error.code, label).toBe("invalid_params");
  }

  it("rejects an unregistered lane with unknown_lane and echoes the rejected value", async () => {
    const res = await submit(server.baseUrl, ALICE.rawKey, { lane: "nosuchlane" });
    expect(res.status).toBe(400);
    const body = res.body as ErrorEnvelope;
    expect(body.error.code).toBe("unknown_lane");
    expect(body.error.lane).toBe("nosuchlane");
  });

  it("rejects a missing lane and a malformed params value", async () => {
    const missingLane = await submit(server.baseUrl, ALICE.rawKey, {});
    expectInvalidParams(missingLane, "missing lane");

    const arrayParams = await submit(server.baseUrl, ALICE.rawKey, { lane: "scrape", params: [] });
    expectInvalidParams(arrayParams, "params is an array");

    const stringParams = await submit(server.baseUrl, ALICE.rawKey, { lane: "scrape", params: "x" });
    expectInvalidParams(stringParams, "params is a string");

    const numberParams = await submit(server.baseUrl, ALICE.rawKey, { lane: "scrape", params: 1 });
    expectInvalidParams(numberParams, "params is a number");
  });

  it("rejects out-of-range or wrong-typed duration_ms", async () => {
    const cases: Array<{ label: string; duration_ms: unknown }> = [
      { label: "negative", duration_ms: -1 },
      { label: "zero", duration_ms: 0 },
      { label: "non-integer", duration_ms: 1.5 },
      { label: "string", duration_ms: "10000" },
      { label: "above max", duration_ms: 600001 },
    ];

    for (const c of cases) {
      const res = await submit(server.baseUrl, ALICE.rawKey, {
        lane: "scrape",
        params: { duration_ms: c.duration_ms },
      });
      expectInvalidParams(res, `duration_ms: ${c.label}`);
    }
  });

  it("rejects non-boolean fail and fail_permanent", async () => {
    const cases: Array<{ label: string; params: Record<string, unknown> }> = [
      { label: 'fail: "yes"', params: { fail: "yes" } },
      { label: "fail: 1", params: { fail: 1 } },
      { label: 'fail_permanent: "yes"', params: { fail_permanent: "yes" } },
      { label: "fail_permanent: 1", params: { fail_permanent: 1 } },
    ];

    for (const c of cases) {
      const res = await submit(server.baseUrl, ALICE.rawKey, { lane: "scrape", params: c.params });
      expectInvalidParams(res, c.label);
    }
  });

  it("rejects out-of-range or non-integer max_attempts", async () => {
    const cases: Array<{ label: string; max_attempts: unknown }> = [
      { label: "zero", max_attempts: 0 },
      { label: "above max", max_attempts: 11 },
      { label: "non-integer", max_attempts: 2.5 },
    ];

    for (const c of cases) {
      const res = await submit(server.baseUrl, ALICE.rawKey, { lane: "scrape", max_attempts: c.max_attempts });
      expectInvalidParams(res, `max_attempts: ${c.label}`);
    }
  });

  it("rejects a malformed JSON body and an unknown top-level field", async () => {
    const malformed = await request<ErrorEnvelope>(server.baseUrl, {
      method: "POST",
      path: "/tasks",
      key: ALICE.rawKey,
      body: '{"lane":',
      headers: { "Content-Type": "application/json" },
    });
    expectInvalidParams(malformed, "malformed JSON body");

    const unknownField = await submit(server.baseUrl, ALICE.rawKey, { lane: "scrape", unknown: 1 });
    expectInvalidParams(unknownField, "unknown top-level field");
  });

  it("rejects a non-UUID id on GET /tasks/id/{id}", async () => {
    const res = await getById(server.baseUrl, ALICE.rawKey, "not-a-uuid");
    expectInvalidParams(res, "GET /tasks/id/not-a-uuid");
  });

  it("passes through unknown keys inside params", async () => {
    const res = await submit(server.baseUrl, ALICE.rawKey, {
      lane: "scrape",
      params: { duration_ms: 1000, custom: "x" },
    });
    expect(res.status).toBe(201);
    expect((res.body as TaskObject).status).toBe("queued");
  });
});
