/**
 * Handle allocation — docs/architecture.md §6, verbatim SQL. Runs inside
 * the submit transaction, after the caller has BEGUN it. The 23505
 * backstop/retry-bounded-3 lives in engine.ts (it needs to retry the whole
 * transaction, not just this query).
 */
import type { Queryable } from "./transitions.js";
import { ACTIVE_PREDICATE } from "./transitions.js";

export { ACTIVE_PREDICATE };

/** Serializes concurrent allocation for exactly this (user, lane) pair. */
export async function lockAllocator(client: Queryable, userId: string, lane: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [userId, lane]);
}

/**
 * Lowest free handle_num among ACTIVE tasks in (user, lane) — verbatim
 * candidate query from architecture §6.
 */
export async function nextHandleNum(client: Queryable, userId: string, lane: string): Promise<number> {
  const { rows } = await client.query<{ handle_num: number }>(
    `SELECT COALESCE(MIN(candidate), 1)::int AS handle_num FROM (
       SELECT 1 AS candidate
       UNION
       SELECT handle_num + 1 FROM tasks
        WHERE user_id = $1 AND lane = $2 AND ${ACTIVE_PREDICATE}
     ) c
     WHERE NOT EXISTS (
       SELECT 1 FROM tasks t
        WHERE t.user_id = $1 AND t.lane = $2 AND ${ACTIVE_PREDICATE}
          AND t.handle_num = c.candidate
     )`,
    [userId, lane]
  );
  const row = rows[0];
  if (!row) throw new Error("nextHandleNum: candidate query produced no row");
  return row.handle_num;
}

/** True when `err` is a Postgres unique-violation (23505) on `one_active_handle`. */
export function isActiveHandleConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; constraint?: string };
  return e.code === "23505" && (e.constraint === undefined || e.constraint === "one_active_handle");
}
