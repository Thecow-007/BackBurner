/**
 * The counters are the one place this UI could most easily start lying. The
 * server re-bases them on every snapshot, but between snapshots the store
 * adjusts them locally as events land (ADR 0018) — and each field has a
 * different filter basis, which is exactly the kind of thing that goes subtly
 * wrong. These tests pin every basis.
 */
import { describe, expect, it } from "vitest";

import { adjustCounts } from "../src/store/store.js";
import type { Counts, Task, TaskFilters, TaskStatus } from "../src/lib/types.js";

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

function counts(over: Partial<Counts> = {}): Counts {
  return {
    all: 10,
    matching: 10,
    uncollected: 2,
    status: { queued: 3, running: 2, ready: 3, failed: 1, cancelled: 1 },
    lane: { scrape: 6, report: 4 },
    lanes: ["scrape", "report"],
    ...over,
  };
}

const NO_FILTERS: TaskFilters = {};

describe("adjustCounts — no filters", () => {
  it("moves a task between statuses without changing the total", () => {
    const before = task({ status: "queued" });
    const after = task({ status: "running" });
    const next = adjustCounts(counts(), before, after, NO_FILTERS);

    expect(next?.status.queued).toBe(2);
    expect(next?.status.running).toBe(3);
    expect(next?.all).toBe(10);
    expect(next?.matching).toBe(10);
  });

  it("counts a brand-new task as an arrival everywhere", () => {
    const next = adjustCounts(counts(), undefined, task({ status: "queued" }), NO_FILTERS);

    expect(next?.all).toBe(11);
    expect(next?.matching).toBe(11);
    expect(next?.status.queued).toBe(4);
    expect(next?.lane.scrape).toBe(7);
  });

  it("keeps sum(status) equal to all, which is what the sidebar's All row renders", () => {
    const next = adjustCounts(counts(), undefined, task({ status: "ready" }), NO_FILTERS);
    const sum = Object.values(next!.status).reduce((a, b) => a + b, 0);
    expect(sum).toBe(next!.all);
  });

  it("counts a finished-but-uncollected task toward 'to collect'", () => {
    const before = task({ status: "running" });
    const after = task({ status: "ready", collected: false });
    const next = adjustCounts(counts(), before, after, NO_FILTERS);
    expect(next?.uncollected).toBe(3);
  });

  it("releases 'to collect' when the task is collected, without changing its status", () => {
    const before = task({ status: "ready", collected: false });
    const after = task({ status: "ready", collected: true });
    const next = adjustCounts(counts(), before, after, NO_FILTERS);

    expect(next?.uncollected).toBe(1);
    expect(next?.status.ready).toBe(3); // there is no sixth status
    expect(next?.all).toBe(10);
  });

  it("never goes negative, even if a delta arrives out of step", () => {
    const zeroed = counts({ status: { queued: 0, running: 0, ready: 0, failed: 0, cancelled: 0 }, all: 0, matching: 0, uncollected: 0 });
    const next = adjustCounts(zeroed, task({ status: "queued" }), undefined, NO_FILTERS);
    expect(next?.status.queued).toBe(0);
    expect(next?.all).toBe(0);
  });

  it("leaves counts untouched before the first snapshot lands", () => {
    expect(adjustCounts(null, undefined, task(), NO_FILTERS)).toBeNull();
  });
});

describe("adjustCounts — the per-field filter bases", () => {
  it("status counts ignore the status filter, so every row stays live while one is selected", () => {
    const filters: TaskFilters = { status: "running" };
    const next = adjustCounts(counts(), task({ status: "queued" }), task({ status: "running" }), filters);

    // Both ends move even though only `running` is selected — otherwise the
    // sidebar would freeze the moment a user filtered.
    expect(next?.status.queued).toBe(2);
    expect(next?.status.running).toBe(3);
    // `matching` respects the filter: the task entered the selected status.
    expect(next?.matching).toBe(11);
  });

  it("status counts DO respect the lane filter", () => {
    const filters: TaskFilters = { lane: "report" };
    const next = adjustCounts(
      counts(),
      task({ status: "queued", lane: "scrape" }),
      task({ status: "running", lane: "scrape" }),
      filters
    );

    // A scrape task moving while the register is filtered to report must not
    // move the numbers next to the report list.
    expect(next?.status.queued).toBe(3);
    expect(next?.status.running).toBe(2);
    expect(next?.matching).toBe(10);
  });

  it("lane counts ignore the lane filter but respect the status filter", () => {
    const filters: TaskFilters = { lane: "scrape", status: "ready" };

    // A report task becoming ready enters the status basis, so lane.report moves.
    const entering = adjustCounts(
      counts(),
      task({ status: "running", lane: "report" }),
      task({ status: "ready", lane: "report" }),
      filters
    );
    expect(entering?.lane.report).toBe(5);

    // A report task moving between two non-`ready` statuses does not.
    const irrelevant = adjustCounts(
      counts(),
      task({ status: "queued", lane: "report" }),
      task({ status: "running", lane: "report" }),
      filters
    );
    expect(irrelevant?.lane.report).toBe(4);
  });

  it("`all` ignores both status and lane, so it only moves on arrival or departure", () => {
    const filters: TaskFilters = { status: "ready", lane: "report" };

    const moved = adjustCounts(
      counts(),
      task({ status: "queued", lane: "scrape" }),
      task({ status: "running", lane: "scrape" }),
      filters
    );
    expect(moved?.all).toBe(10);

    const arrived = adjustCounts(counts(), undefined, task({ lane: "scrape" }), filters);
    expect(arrived?.all).toBe(11);
  });

  it("respects the date window on every basis", () => {
    const filters: TaskFilters = { from: "2026-07-26T00:00:00.000Z", to: "2026-07-27T00:00:00.000Z" };
    const outside = task({ created_at: "2026-07-01T12:00:00.000Z", status: "ready" });

    const next = adjustCounts(counts(), undefined, outside, filters);

    expect(next?.all).toBe(10);
    expect(next?.matching).toBe(10);
    expect(next?.status.ready).toBe(3);
    expect(next?.lane.scrape).toBe(6);
  });

  it("removes a row from `matching` when it transitions out of the active status filter", () => {
    // This is the list-is-always-a-true-answer rule, counted.
    const filters: TaskFilters = { status: "queued" };
    const next = adjustCounts(counts(), task({ status: "queued" }), task({ status: "running" }), filters);
    expect(next?.matching).toBe(9);
  });
});
