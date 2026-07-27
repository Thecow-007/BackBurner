/**
 * `matchesFilters` is the client-side mirror of the server's WHERE clause. It
 * exists so the live list stays a true answer to the active filter between
 * snapshots — a row that transitions out of the filter has to leave the moment
 * its event lands, not on the next hydration.
 *
 * The `uncollected` filter is the one that can most easily drift, because it is
 * a compound predicate (`status IN ('ready','failed') AND collected = false`)
 * rather than an equality, and because the same predicate is also a COUNT. If
 * this mirror and `counts.uncollected` ever disagree, the sidebar's "to collect"
 * number opens a list with a different number of rows in it — the exact bug
 * ui-spec §3.10 names.
 */
import { describe, expect, it } from "vitest";

import { isUncollected, matchesFilters } from "../src/lib/filters.js";
import type { Task, TaskFilters, TaskStatus } from "../src/lib/types.js";

function task(over: Partial<Task> = {}): Task {
  return {
    handle: "scrape-1",
    lane: "scrape",
    params: {},
    status: "queued",
    result: null,
    error: null,
    created_at: "2026-07-26T12:00:00.000Z",
    updated_at: "2026-07-26T12:00:00.000Z",
    collected: false,
    id: "0198f2c4-7b31-7a90-9d44-6c11e0f9a2b8",
    attempts: 0,
    max_attempts: 3,
    seeded: false,
    ...over,
  };
}

const UNCOLLECTED: TaskFilters = { uncollected: true };
const ALL_STATUSES: readonly TaskStatus[] = ["queued", "running", "ready", "failed", "cancelled"];

describe("matchesFilters — the uncollected filter", () => {
  it("admits exactly ready and failed, and only while uncollected", () => {
    // The full truth table, so the predicate cannot be narrowed by accident.
    const admitted = ALL_STATUSES.filter((status) =>
      matchesFilters(task({ status, collected: false }), UNCOLLECTED)
    );
    expect(admitted).toEqual(["ready", "failed"]);

    const admittedAfterCollect = ALL_STATUSES.filter((status) =>
      matchesFilters(task({ status, collected: true }), UNCOLLECTED)
    );
    expect(admittedAfterCollect).toEqual([]);
  });

  it("is the same predicate `counts.uncollected` is built on", () => {
    for (const status of ALL_STATUSES) {
      for (const collected of [false, true]) {
        const t = task({ status, collected });
        expect(matchesFilters(t, UNCOLLECTED)).toBe(isUncollected(t));
      }
    }
  });

  it("drops a task out of the list the instant it is collected", () => {
    const ready = task({ status: "ready", collected: false });
    expect(matchesFilters(ready, UNCOLLECTED)).toBe(true);
    // The `collected` event flips one field; the row must leave immediately.
    expect(matchesFilters({ ...ready, collected: true }, UNCOLLECTED)).toBe(false);
  });

  it("changes nothing when the filter is absent", () => {
    for (const status of ALL_STATUSES) {
      expect(matchesFilters(task({ status, collected: true }), {})).toBe(true);
    }
  });

  it("composes with the other filters rather than replacing them", () => {
    const filters: TaskFilters = { uncollected: true, lane: "report" };
    expect(matchesFilters(task({ status: "ready", lane: "report" }), filters)).toBe(true);
    // Uncollected but in the wrong lane.
    expect(matchesFilters(task({ status: "ready", lane: "scrape" }), filters)).toBe(false);
    // Right lane but already collected.
    expect(
      matchesFilters(task({ status: "ready", lane: "report", collected: true }), filters)
    ).toBe(false);
  });

  it("composes with the date window", () => {
    const filters: TaskFilters = {
      uncollected: true,
      from: "2026-07-26T00:00:00.000Z",
      to: "2026-07-27T00:00:00.000Z",
    };
    expect(matchesFilters(task({ status: "failed" }), filters)).toBe(true);
    expect(
      matchesFilters(task({ status: "failed", created_at: "2026-07-01T12:00:00.000Z" }), filters)
    ).toBe(false);
  });

  it("can be combined with a status filter, and then both bite", () => {
    // `?status=ready&uncollected=true` is legal and means both, not either.
    const filters: TaskFilters = { uncollected: true, status: "ready" };
    expect(matchesFilters(task({ status: "ready" }), filters)).toBe(true);
    expect(matchesFilters(task({ status: "failed" }), filters)).toBe(false);
    expect(matchesFilters(task({ status: "ready", collected: true }), filters)).toBe(false);
  });
});
