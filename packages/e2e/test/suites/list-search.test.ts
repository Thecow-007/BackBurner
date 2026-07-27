import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ALICE,
  BOB,
  EventCapture,
  T_EVENT,
  T_JOB,
  collect,
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
 * Supplemental suite 5.14 — the `?q=` free-text lookup (api-contract.md §7,
 * ADR 0022).
 *
 * `q` matches a task's derived handle or its id, by equality or by prefix, so
 * `q=scrape` returns every scrape and `q=scrape-1` returns `scrape-1`,
 * `scrape-10`, `scrape-19`… Three properties make it a different read from
 * every other filter, and all three are under test here:
 *
 *   1. **It is ranked, not sorted.** Exact matches first, then tasks that
 *      still hold their handle, then newest-first. That matters precisely
 *      because handles recycle: a live `report-1` and a released former
 *      `report-1` are both honest answers to `q=report-1`, and the live one
 *      is the one the operator meant.
 *   2. **It is unpaginated.** `next_cursor` is always `null`; `limit` still
 *      caps the page, and `counts.matching` carries the true total so a
 *      client can say "showing 5 of 12 matches" without inventing a number.
 *   3. **It refuses to guess.** `q` with `sort` or with `cursor` is a `400`
 *      naming the conflict rather than a silent precedence rule.
 *
 * ── Canonical supplemental-suite lifecycle (test-plan.md §3.1-§3.2) ──
 * One server per FILE, `settle()` + truncate between tests.
 *
 * ── Corpus (15 tasks, built fresh per test) ──
 * `convert-1` ready+uncollected; `report-1` ready+collected (a RELEASED
 * handle); a second `report-1` still holding the recycled handle; and
 * `scrape-1` … `scrape-12`, all long-running so they provably still hold
 * their handles for the whole test.
 */
describe("list-search", () => {
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

  /** Fast enough to reach `ready` inside one T_JOB window. */
  const SHORT_MS = 250;
  /** Long enough that a task provably still holds its handle all test. */
  const LONG_MS = 60_000;
  const SCRAPE_COUNT = 12;

  interface Corpus {
    /** ready + uncollected, the only uncollected task in the register. */
    convert: TaskObject;
    /** ready + collected — a RELEASED former holder of `report-1`. */
    reportReleased: TaskObject;
    /** queued/running — the current holder of the recycled `report-1`. */
    reportActive: TaskObject;
    /** `scrape-1` … `scrape-12`, in submission order. */
    scrapes: TaskObject[];
  }

  async function submitTask(lane: string, params: Record<string, unknown>): Promise<TaskObject> {
    const res = await submit(server.baseUrl, ALICE.rawKey, { lane, params });
    expect(res.status, `submit ${lane}: ${JSON.stringify(res.body)}`).toBe(201);
    return res.body as TaskObject;
  }

  async function buildCorpus(cap: EventCapture): Promise<Corpus> {
    // 1. A finished-but-uncollected task, in its own lane.
    const convert = await submitTask("convert", { duration_ms: SHORT_MS });
    await cap.waitFor(
      (e) => e.type === "ready" && e.task_id === convert.id,
      T_JOB(SHORT_MS),
      `ready for ${convert.handle}`,
      server
    );

    // 2. `report-1`, finished and COLLECTED — which frees the handle.
    const reportReleased = await submitTask("report", { duration_ms: SHORT_MS });
    expect(reportReleased.handle).toBe("report-1");
    await cap.waitFor(
      (e) => e.type === "ready" && e.task_id === reportReleased.id,
      T_JOB(SHORT_MS),
      `ready for ${reportReleased.handle}`,
      server
    );
    const collected = await collect(server.baseUrl, ALICE.rawKey, reportReleased.handle);
    expect(collected.status).toBe(200);
    await cap.waitFor(
      (e) => e.type === "collected" && e.task_id === reportReleased.id,
      T_EVENT,
      `collected for ${reportReleased.handle}`,
      server
    );

    // 3. …and a new task that takes the freed number. Two distinct tasks now
    // answer to `report-1`; only this one holds it.
    const reportActive = await submitTask("report", { duration_ms: LONG_MS });
    expect(reportActive.handle, "the freed handle is re-leased").toBe("report-1");
    expect(reportActive.id).not.toBe(reportReleased.id);

    // 4. scrape-1 … scrape-12, all long-running.
    const scrapes: TaskObject[] = [];
    for (let i = 1; i <= SCRAPE_COUNT; i++) {
      const task = await submitTask("scrape", { duration_ms: LONG_MS });
      expect(task.handle, `scrape #${i}`).toBe(`scrape-${i}`);
      scrapes.push(task);
    }

    return { convert, reportReleased, reportActive, scrapes };
  }

  async function search(q: string, extra: ListQuery = {}): Promise<TaskListResponse> {
    const res = await listTasks(server.baseUrl, ALICE.rawKey, { q, limit: 200, ...extra });
    expect(res.status, `?q=${q}: ${JSON.stringify(res.body)}`).toBe(200);
    return res.body as TaskListResponse;
  }

  function handles(body: TaskListResponse): string[] {
    return body.tasks.map((t) => t.handle);
  }

  // ── Matching set ──────────────────────────────────────────────────────

  it("matches by handle prefix, exact handle, exact id, and id prefix", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    const c = await buildCorpus(cap);

    // A bare lane name is a handle prefix: every task in that lane.
    const allScrapes = await search("scrape");
    expect(allScrapes.tasks.length, "q=scrape rows").toBe(SCRAPE_COUNT);
    expect(allScrapes.tasks.every((t) => t.lane === "scrape")).toBe(true);
    expect(allScrapes.counts.matching, "matching is the true total").toBe(SCRAPE_COUNT);

    // A partial handle is a prefix too — the documented `scrape-1` case.
    const oneish = await search("scrape-1");
    expect(handles(oneish).sort(), "q=scrape-1 rows").toEqual(
      ["scrape-1", "scrape-10", "scrape-11", "scrape-12"].sort()
    );

    // A complete handle that is nobody's prefix returns exactly one row.
    const twelve = await search("scrape-12");
    expect(handles(twelve)).toEqual(["scrape-12"]);

    // Exact id.
    const target = c.scrapes[4] as TaskObject;
    const byId = await search(target.id);
    expect(byId.tasks.length).toBe(1);
    expect((byId.tasks[0] as TaskObject).id).toBe(target.id);

    // Id prefix. uuidv7 is time-ordered, so a short prefix may legitimately
    // match siblings created in the same millisecond — assert the target is
    // there and that nothing unrelated is.
    const idPrefix = target.id.slice(0, 18);
    const byIdPrefix = await search(idPrefix);
    expect(byIdPrefix.tasks.map((t) => t.id)).toContain(target.id);
    expect(byIdPrefix.tasks.every((t) => t.id.startsWith(idPrefix))).toBe(true);

    // Case-insensitive, both directions.
    expect(handles(await search("SCRAPE-12"))).toEqual(["scrape-12"]);
    expect((await search(target.id.toUpperCase())).tasks.length).toBe(1);

    // No match is an empty list, not a 404.
    const none = await search("nosuchthing");
    expect(none.tasks).toEqual([]);
    expect(none.counts.matching).toBe(0);
    expect(none.next_cursor).toBeNull();

    cap.close();
  });

  it("treats LIKE metacharacters in q as literal text", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    await buildCorpus(cap);

    // Unescaped, `%` and `_` would turn these into wildcards and match the
    // whole register — the classic silent-injection bug in a search box.
    for (const q of ["scrape-%", "%", "_", "scrape_1", "scrape-\\"]) {
      const body = await search(q);
      expect(body.tasks, `q=${JSON.stringify(q)} must match nothing`).toEqual([]);
      expect(body.counts.matching, `q=${JSON.stringify(q)} matching`).toBe(0);
    }

    cap.close();
  });

  it("is scoped to the authenticated user like every other read", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    const c = await buildCorpus(cap);

    const res = await listTasks(server.baseUrl, BOB.rawKey, { q: "scrape" });
    expect(res.status).toBe(200);
    expect((res.body as TaskListResponse).tasks, "Bob sees none of Alice's tasks").toEqual([]);

    // Not even by Alice's immutable id.
    const byId = await listTasks(server.baseUrl, BOB.rawKey, { q: (c.scrapes[0] as TaskObject).id });
    expect((byId.body as TaskListResponse).tasks).toEqual([]);

    cap.close();
  });

  // ── Ranking ───────────────────────────────────────────────────────────

  it("ranks exact matches first, then handle holders, then newest first", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    const c = await buildCorpus(cap);

    // Tier (a) then (c): `scrape-1` is an exact match and outranks the three
    // prefix matches, which then come newest-first.
    expect(handles(await search("scrape-1")), "exact match first, then newest").toEqual([
      "scrape-1",
      "scrape-12",
      "scrape-11",
      "scrape-10",
    ]);

    // Tier (c) alone: no exact match, every row still holds its handle.
    const allScrapes = await search("scrape");
    expect(handles(allScrapes).slice(0, 3), "newest first").toEqual([
      "scrape-12",
      "scrape-11",
      "scrape-10",
    ]);
    expect(handles(allScrapes)[SCRAPE_COUNT - 1]).toBe("scrape-1");

    // Tier (b): two tasks answer to `report-1`; both are exact matches, so
    // the tiebreak is which one still HOLDS the handle. The released former
    // holder is newer in neither sense that matters — it is simply not the
    // task an operator typing `report-1` means.
    const reports = await search("report-1");
    expect(reports.tasks.length, "both holders answer").toBe(2);
    expect((reports.tasks[0] as TaskObject).id, "the active holder ranks first").toBe(
      c.reportActive.id
    );
    expect((reports.tasks[1] as TaskObject).id, "the released former holder follows").toBe(
      c.reportReleased.id
    );
    // …and the released one is genuinely the OLDER row, so this is not
    // created_at ordering wearing a disguise.
    expect(new Date(c.reportReleased.created_at).getTime()).toBeLessThan(
      new Date(c.reportActive.created_at).getTime()
    );

    cap.close();
  });

  // ── Pagination, limits and counts ────────────────────────────────────

  it("is unpaginated: next_cursor is always null, limit caps the page, matching carries the total", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    await buildCorpus(cap);

    const full = await search("scrape");
    expect(full.next_cursor, "null even when nothing was truncated").toBeNull();

    const capped = await search("scrape", { limit: 5 });
    expect(capped.tasks.length, "limit still applies").toBe(5);
    expect(capped.next_cursor, "null even when rows WERE truncated").toBeNull();
    // "showing 5 of 12 matches" — sourced, never inferred from the page.
    expect(capped.counts.matching).toBe(SCRAPE_COUNT);
    // The truncated page is the top of the same ranking.
    expect(handles(capped)).toEqual(handles(full).slice(0, 5));

    // `as_of` still rides along, so snapshot-then-stream hydration works
    // from a search result exactly as from a normal list.
    expect(typeof full.as_of).toBe("number");

    cap.close();
  });

  it("composes with status, lane, uncollected and the date window", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    const c = await buildCorpus(cap);

    // With status: `report-1`'s two holders split cleanly by status.
    const readyReports = await search("report-1", { status: "ready" });
    expect(readyReports.tasks.map((t) => t.id)).toEqual([c.reportReleased.id]);
    expect(readyReports.counts.matching).toBe(1);

    // With lane: a lane that cannot contain the match yields nothing.
    expect((await search("scrape", { lane: "report" })).tasks).toEqual([]);
    expect((await search("scrape", { lane: "scrape" })).tasks.length).toBe(SCRAPE_COUNT);

    // With uncollected: only `convert-1` is finished-and-uncollected.
    const uncollected = await search("convert", { uncollected: "true" });
    expect(uncollected.tasks.map((t) => t.id)).toEqual([c.convert.id]);
    expect((await search("scrape", { uncollected: "true" })).tasks).toEqual([]);

    // With a window: an empty window empties the result.
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    expect((await search("scrape", { to: hourAgo })).tasks).toEqual([]);
    expect((await search("scrape", { from: hourAgo })).tasks.length).toBe(SCRAPE_COUNT);

    cap.close();
  });

  it("narrows matching, status.* and lane.* but leaves all, uncollected, lanes and lane_defaults alone", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    await buildCorpus(cap);

    const unfiltered = (await listTasks(server.baseUrl, ALICE.rawKey, { limit: 200 }))
      .body as TaskListResponse;
    const TOTAL = SCRAPE_COUNT + 3;
    expect(unfiltered.counts.all).toBe(TOTAL);
    expect(unfiltered.counts.uncollected, "only convert-1 is uncollected").toBe(1);

    const body = await search("scrape");
    // Respected by matching…
    expect(body.counts.matching).toBe(SCRAPE_COUNT);
    // …and by both breakdowns: every scrape is queued or running.
    expect(body.counts.status.ready, "no scrape has finished").toBe(0);
    expect(
      body.counts.status.queued + body.counts.status.running,
      "sum(status.*) === matching"
    ).toBe(SCRAPE_COUNT);
    expect(body.counts.lane.scrape).toBe(SCRAPE_COUNT);
    expect(body.counts.lane.report, "lane.* narrows to the search too").toBe(0);
    expect(body.counts.lane.convert).toBe(0);

    // Ignored by the register-wide numbers: the grand total and the
    // uncollected badge are not search-local affordances.
    expect(body.counts.all, "all ignores q").toBe(TOTAL);
    expect(body.counts.uncollected, "the uncollected badge ignores q").toBe(1);
    expect(body.counts.lanes).toEqual(unfiltered.counts.lanes);
    expect(body.counts.lane_defaults).toEqual(unfiltered.counts.lane_defaults);

    cap.close();
  });

  // ── Refusals ──────────────────────────────────────────────────────────

  it("rejects q with sort, q with cursor, and out-of-range q", async () => {
    const cap = new EventCapture(server.baseUrl, ALICE.rawKey, { server });
    await cap.ready;
    await buildCorpus(cap);

    // A real cursor from a real page — so the rejection is about the
    // combination, not about the token being unparseable.
    const paged = await listTasks(server.baseUrl, ALICE.rawKey, { limit: 5 });
    const cursor = (paged.body as TaskListResponse).next_cursor;
    expect(cursor, "corpus is large enough to paginate").not.toBeNull();

    const withCursor = await listTasks(server.baseUrl, ALICE.rawKey, {
      q: "scrape",
      cursor: cursor as string,
    });
    expect(withCursor.status).toBe(400);
    expect((withCursor.body as ErrorEnvelope).error.code).toBe("invalid_params");
    expect(
      (withCursor.body as ErrorEnvelope).error.message,
      "the message names the conflict"
    ).toMatch(/cursor/i);

    for (const sort of ["created_at", "created_at:asc", "updated_at:desc"]) {
      const withSort = await listTasks(server.baseUrl, ALICE.rawKey, { q: "scrape", sort });
      expect(withSort.status, `q + sort=${sort}`).toBe(400);
      expect((withSort.body as ErrorEnvelope).error.code).toBe("invalid_params");
      expect((withSort.body as ErrorEnvelope).error.message).toMatch(/sort/i);
    }

    // Length bounds, measured after trimming.
    for (const q of ["", "   ", "x".repeat(65)]) {
      const res = await listTasks(server.baseUrl, ALICE.rawKey, { q });
      expect(res.status, `q=${JSON.stringify(q)}`).toBe(400);
      expect((res.body as ErrorEnvelope).error.code).toBe("invalid_params");
    }
    // 64 is inside the bound, and whitespace around a term is trimmed, not
    // counted — `  scrape-12  ` is the same query as `scrape-12`.
    expect((await search("x".repeat(64))).tasks).toEqual([]);
    expect(handles(await search("  scrape-12  "))).toEqual(["scrape-12"]);

    cap.close();
  });
});
