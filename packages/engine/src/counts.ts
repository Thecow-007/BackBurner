/**
 * Aggregate task counts — docs/api-contract.md §6.2 (`counts`, [EXTENSION]),
 * docs/build-plan.md ("Task counts"). Mirrors `list.ts`: same user scoping,
 * same filter vocabulary (parsed by the shared `filters.ts`, so a count can
 * never read `status`/`from`/`to`/`uncollected`/`q` differently from the list
 * it opens).
 *
 * Each number has a DIFFERENT filter basis, because each answers a different
 * question in the dashboard:
 *
 * | Field         | Respects                        | Ignores           |
 * |---------------|---------------------------------|-------------------|
 * | `all`         | from, to                        | status, lane, uncollected, q |
 * | `matching`    | every active filter             | nothing           |
 * | `uncollected` | lane, from, to                  | status, uncollected, q |
 * | `status.*`    | lane, from, to, uncollected, q  | status            |
 * | `lane.*`      | status, from, to, uncollected, q| lane              |
 * | `lanes`       | nothing (engine lane registration, not data)         |
 *
 * `uncollected` the *count* ignores `uncollected` the *filter* for the same
 * reason it ignores `status`: it IS that predicate. It is the badge that
 * opens the filter, so narrowing it by its own filter would make it collapse
 * to itself the moment a user clicked it. `q` is treated the same way — the
 * inbox number is a register-wide affordance, not a search-local one.
 *
 * All of it is ONE round trip: a single scan over the user's rows inside the
 * date window, with `COUNT(*) FILTER (WHERE ...)` doing the slicing. That is
 * not only cheaper than five queries — it is what makes the numbers mutually
 * consistent, since every aggregate sees the identical snapshot. In
 * particular `sum(status.*) === all` holds exactly whenever no lane,
 * `uncollected`, or `q` filter is active, which is what the sidebar's "All"
 * row renders.
 *
 * `sort`, `limit`, and `cursor` are accepted (the caller passes the same
 * `ListFilters` it hands `list()`) and deliberately ignored: counts describe
 * the whole matching set, not one page of it. `sort` and `cursor` alongside
 * `q` are still rejected here, exactly as `list()` rejects them, so the two
 * calls can never disagree about whether a request was valid.
 */
import type { Pool } from "pg";
import {
  UNCOLLECTED_PREDICATE,
  buildSearchMatch,
  parseSearchFilter,
  parseStatusFilter,
  parseTimestamp,
  parseUncollectedFilter,
} from "./filters.js";
import type { ListFilters, TaskCounts, TaskStatus } from "./types.js";

/** pg returns `bigint` as a string; every aggregate below is cast to `int`
 * in SQL, but the coercion is kept honest here anyway. */
function toCount(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseInt(value, 10);
  return 0;
}

export async function countTasks(
  pool: Pool,
  userId: string,
  registeredLanes: readonly string[],
  filters: ListFilters
): Promise<TaskCounts> {
  const status = parseStatusFilter(filters.status);
  const fromDate = filters.from !== undefined ? parseTimestamp(filters.from, "from") : undefined;
  const toDate = filters.to !== undefined ? parseTimestamp(filters.to, "to") : undefined;
  const uncollectedOnly = parseUncollectedFilter(filters.uncollected);
  const q = parseSearchFilter(filters);

  // The scope every number shares: the caller's own tasks, inside the date
  // window. `status`, `lane`, `uncollected` and `q` are NOT scope — they are
  // per-aggregate.
  const conditions: string[] = ["user_id = $1"];
  const values: unknown[] = [userId];

  if (fromDate !== undefined) {
    values.push(fromDate);
    conditions.push(`created_at >= $${values.length}`);
  }
  if (toDate !== undefined) {
    values.push(toDate);
    conditions.push(`created_at < $${values.length}`);
  }

  let statusMatch = "TRUE";
  if (status !== undefined) {
    values.push(status);
    statusMatch = `status = $${values.length}`;
  }
  let laneMatch = "TRUE";
  if (filters.lane !== undefined) {
    values.push(filters.lane);
    laneMatch = `lane = $${values.length}`;
  }
  // The filter is the same string of SQL as the `uncollected` count below —
  // the number and the view it opens cannot drift apart.
  const uncollectedMatch = uncollectedOnly ? `(${UNCOLLECTED_PREDICATE})` : "TRUE";
  const searchMatch = q !== undefined ? buildSearchMatch(q, values) : "TRUE";

  // Everything except `all` and the `uncollected` count narrows by these two.
  const active = `${uncollectedMatch} AND ${searchMatch}`;

  const sql = `
    WITH scoped AS (
      SELECT id, status, lane, handle_num, collected FROM tasks WHERE ${conditions.join(" AND ")}
    ),
    totals AS (
      SELECT
        COUNT(*)::int AS all_count,
        COUNT(*) FILTER (WHERE ${statusMatch} AND ${laneMatch} AND ${active})::int AS matching,
        COUNT(*) FILTER (WHERE ${laneMatch} AND ${UNCOLLECTED_PREDICATE})::int AS uncollected,
        COUNT(*) FILTER (WHERE ${laneMatch} AND ${active} AND status = 'queued')::int AS status_queued,
        COUNT(*) FILTER (WHERE ${laneMatch} AND ${active} AND status = 'running')::int AS status_running,
        COUNT(*) FILTER (WHERE ${laneMatch} AND ${active} AND status = 'ready')::int AS status_ready,
        COUNT(*) FILTER (WHERE ${laneMatch} AND ${active} AND status = 'failed')::int AS status_failed,
        COUNT(*) FILTER (WHERE ${laneMatch} AND ${active} AND status = 'cancelled')::int AS status_cancelled
      FROM scoped
    ),
    per_lane AS (
      SELECT lane, COUNT(*)::int AS n FROM scoped WHERE ${statusMatch} AND ${active} GROUP BY lane
    )
    SELECT
      totals.*,
      COALESCE((SELECT jsonb_object_agg(lane, n) FROM per_lane), '{}'::jsonb) AS lane_counts
    FROM totals`;

  const { rows } = await pool.query<Record<string, unknown>>(sql, values);
  const row = rows[0];
  if (!row) throw new Error("counts: aggregate query returned no row");

  // All five keys, always, zero-valued when empty — the sidebar renders a
  // row per status and must never be handed a hole.
  const statusCounts: Record<TaskStatus, number> = {
    queued: toCount(row.status_queued),
    running: toCount(row.status_running),
    ready: toCount(row.status_ready),
    failed: toCount(row.status_failed),
    cancelled: toCount(row.status_cancelled),
  };

  const observed = (row.lane_counts ?? {}) as Record<string, unknown>;
  const laneCounts: Record<string, number> = {};
  // Registration order first, zero-filled: a lane with no tasks is still a
  // lane you can submit to.
  for (const lane of registeredLanes) laneCounts[lane] = toCount(observed[lane]);
  // Then anything the data holds that is no longer registered — those rows
  // exist, so hiding them from the per-lane breakdown would be a lie.
  for (const [lane, n] of Object.entries(observed)) {
    if (!(lane in laneCounts)) laneCounts[lane] = toCount(n);
  }

  return {
    all: toCount(row.all_count),
    matching: toCount(row.matching),
    uncollected: toCount(row.uncollected),
    status: statusCounts,
    lane: laneCounts,
    // Engine registration, not `SELECT DISTINCT lane` — the submit form's
    // lane picker is built from this, so a brand-new user with zero tasks
    // must still receive the full list. Copied so callers cannot mutate it.
    lanes: [...registeredLanes],
  };
}
