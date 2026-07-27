/**
 * The search overlay reads the server (ADR 0027) — the fifth read moment, and
 * the only one whose answer must NOT reach the store.
 *
 * Merging search hits into `tasksById`/`listOrder` would splice foreign rows
 * into the register's server-given list order, and adopting the response's
 * `counts` would replace numbers whose basis is the register's filters with
 * numbers whose basis is a search term. Both would be silent corruption of the
 * one thing this app promises to get right, so they are pinned here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task, TaskListResponse } from "../src/lib/types.js";
import { createBackburnerStore } from "../src/store/store.js";

function task(over: Partial<Task> = {}): Task {
  return {
    handle: "scrape-1",
    lane: "scrape",
    params: {},
    status: "ready",
    result: null,
    error: null,
    created_at: "2026-07-26T12:00:00.000Z",
    updated_at: "2026-07-26T12:00:00.000Z",
    collected: false,
    id: "0198f2c4-7b31-7a90-9d44-6c11e0f9a2b8",
    attempts: 1,
    max_attempts: 3,
    seeded: false,
    ...over,
  };
}

const REGISTER_TASK = task({ handle: "scrape-9", id: "0198f2c4-0000-7a90-9d44-000000000001" });

/** What the snapshot returns; `counts` here is the REGISTER's basis. */
const SNAPSHOT: TaskListResponse = {
  tasks: [REGISTER_TASK],
  as_of: 4131,
  next_cursor: null,
  counts: {
    all: 312,
    matching: 1,
    uncollected: 19,
    status: { queued: 2, running: 4, ready: 168, failed: 77, cancelled: 61 },
    lane: { scrape: 184, report: 128 },
    lanes: ["scrape", "report"],
  },
};

/** What `?q=` returns: different rows, and a `matching` on a different basis. */
const SEARCH_PAGE: TaskListResponse = {
  tasks: [
    task({ handle: "scrape-1", id: "0198f2c4-0000-7a90-9d44-00000000000a" }),
    task({ handle: "scrape-10", id: "0198f2c4-0000-7a90-9d44-00000000000b" }),
    task({ handle: "scrape-19", id: "0198f2c4-0000-7a90-9d44-00000000000c" }),
  ],
  as_of: 4131,
  next_cursor: null,
  counts: { ...SNAPSHOT.counts!, matching: 184 },
};

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("store.search", () => {
  let requested: string[];

  beforeEach(() => {
    requested = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requested.push(url);
        return jsonResponse(url.includes("q=") ? SEARCH_PAGE : SNAPSHOT);
      })
    );
  });

  async function signedInStore() {
    const store = createBackburnerStore();
    await store.getState().signIn("bb_" + "0".repeat(40));
    return store;
  }

  it("sends q and a limit, and never sort or cursor (both are a 400 with q)", async () => {
    const store = await signedInStore();
    requested.length = 0;

    await store.getState().search("scrape");

    expect(requested).toHaveLength(1);
    const url = requested[0]!;
    expect(url).toContain("q=scrape");
    expect(url).toContain("limit=20");
    expect(url).not.toContain("sort=");
    expect(url).not.toContain("cursor=");
  });

  it("returns the server's rows in the server's order, and the true total", async () => {
    const store = await signedInStore();

    const result = await store.getState().search("scrape");

    // Rank order is the server's: exact match first. Rendered verbatim.
    expect(result.tasks.map((t) => t.handle)).toEqual(["scrape-1", "scrape-10", "scrape-19"]);
    expect(result.matching).toBe(184);
  });

  it("leaves tasksById, listOrder, counts and historyById completely untouched", async () => {
    const store = await signedInStore();
    const before = store.getState();
    const tasksById = before.tasksById;
    const listOrder = before.listOrder;
    const counts = before.counts;
    const historyById = before.historyById;

    // The register holds exactly the snapshot's one row before the search.
    expect([...tasksById.keys()]).toEqual([REGISTER_TASK.id]);
    expect(listOrder).toEqual([REGISTER_TASK.id]);
    expect(counts?.matching).toBe(1);

    await store.getState().search("scrape");

    const after = store.getState();
    // Reference equality: the search did not even rebuild these, let alone
    // change them.
    expect(after.tasksById).toBe(tasksById);
    expect(after.listOrder).toBe(listOrder);
    expect(after.counts).toBe(counts);
    expect(after.historyById).toBe(historyById);

    // And spelled out, in case a future refactor starts cloning state:
    expect([...after.tasksById.keys()]).toEqual([REGISTER_TASK.id]);
    expect(after.listOrder).toEqual([REGISTER_TASK.id]);
    // The register's `matching`, not the search's 184.
    expect(after.counts?.matching).toBe(1);
  });

  it("does not disturb the register even when a hit shares an id with a loaded row", async () => {
    const store = await signedInStore();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ...SEARCH_PAGE,
          // Same id as the loaded row, but collected — merging this would flip
          // the register row's lease state on a mere search.
          tasks: [{ ...REGISTER_TASK, collected: true }],
        })
      )
    );

    await store.getState().search("scrape-9");

    expect(store.getState().tasksById.get(REGISTER_TASK.id)?.collected).toBe(false);
  });
});
