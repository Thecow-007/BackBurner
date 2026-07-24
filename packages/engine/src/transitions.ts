/**
 * CAS transition operations + the transition journal + the per-user commit
 * lock. docs/architecture.md §7 (CAS enforcement), §8 (claim), §9/§10
 * (completion + cancel), §11 (per-user commit lock). Every function here
 * runs against a single client (expected to be inside an open transaction
 * managed by the caller via db.ts's withTransaction) and returns the
 * updated row, or null when the CAS matched zero rows (caller decides how
 * to react — InvalidStateError, or a tolerated skip during recovery).
 */
import type { Pool, PoolClient } from "pg";
import type { TaskRow, TaskStatus, TransitionRow } from "./types.js";

export type Queryable = Pool | PoolClient;

/** ACTIVE per docs/architecture.md §4 — verbatim `one_active_handle` predicate. */
export const ACTIVE_PREDICATE =
  "(status IN ('queued','running') OR (status IN ('ready','failed') AND NOT collected))";

/**
 * Per-user commit-order lock (architecture §11) — a DIFFERENT key class
 * than the allocator's (user, lane) lock (§6): keyed on (userId, '#commit'),
 * a lane name that can never be real (lane grammar excludes '#').
 */
export async function lockCommitOrder(client: Queryable, userId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
    userId,
    "#commit",
  ]);
}

export interface InsertTransitionInput {
  taskId: string;
  userId: string;
  eventType: string;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus | null;
  meta: Record<string, unknown>;
}

/** Journal insert — always immediately preceded by the per-user commit lock. */
export async function insertTransition(
  client: Queryable,
  input: InsertTransitionInput
): Promise<TransitionRow> {
  await lockCommitOrder(client, input.userId);
  const { rows } = await client.query<TransitionRow>(
    `INSERT INTO task_transitions (task_id, user_id, event_type, from_status, to_status, meta)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [input.taskId, input.userId, input.eventType, input.fromStatus, input.toStatus, input.meta]
  );
  const row = rows[0];
  if (!row) throw new Error("insertTransition: INSERT ... RETURNING produced no row");
  return row;
}

/**
 * Dispatch claim (architecture §8) — verbatim. Not id-keyed; the WHERE
 * clause picks the single lowest-enqueued eligible row itself.
 */
export async function claimQueuedTask(client: Queryable): Promise<TaskRow | null> {
  const { rows } = await client.query<TaskRow>(
    `UPDATE tasks SET status='running', started_at=now(), attempts=attempts+1, updated_at=now()
     WHERE id = (
       SELECT id FROM tasks
       WHERE status='queued' AND (run_after IS NULL OR run_after <= now())
       ORDER BY enqueued_at, id
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`
  );
  return rows[0] ?? null;
}

/** Epoch-guarded completion CAS: running -> ready. */
export async function completeReady(
  client: Queryable,
  taskId: string,
  attemptsAtClaim: number,
  result: unknown
): Promise<TaskRow | null> {
  const { rows } = await client.query<TaskRow>(
    `UPDATE tasks SET status='ready', result=$2, updated_at=now()
     WHERE id=$1 AND status='running' AND attempts=$3
     RETURNING *`,
    [taskId, result ?? null, attemptsAtClaim]
  );
  return rows[0] ?? null;
}

/** Epoch-guarded completion CAS: running -> failed (non-retryable or budget exhausted). */
export async function completeFailed(
  client: Queryable,
  taskId: string,
  attemptsAtClaim: number,
  error: { reason: string; retryable: boolean }
): Promise<TaskRow | null> {
  const { rows } = await client.query<TaskRow>(
    `UPDATE tasks SET status='failed', error=$2, updated_at=now()
     WHERE id=$1 AND status='running' AND attempts=$3
     RETURNING *`,
    [taskId, error, attemptsAtClaim]
  );
  return rows[0] ?? null;
}

/** Epoch-guarded completion CAS: running -> queued (retryable failure, budget remains). */
export async function completeRetrying(
  client: Queryable,
  taskId: string,
  attemptsAtClaim: number,
  error: { reason: string; retryable: boolean },
  runAfter: Date
): Promise<TaskRow | null> {
  const { rows } = await client.query<TaskRow>(
    `UPDATE tasks SET status='queued', error=$2, run_after=$3, enqueued_at=now(), updated_at=now()
     WHERE id=$1 AND status='running' AND attempts=$4
     RETURNING *`,
    [taskId, error, runAfter, attemptsAtClaim]
  );
  return rows[0] ?? null;
}

export interface CancelResult {
  row: TaskRow;
  fromStatus: TaskStatus;
}

/** Cancel — the multi-state CTE-CAS, verbatim (architecture §10). */
export async function cancelTask(client: Queryable, taskId: string): Promise<CancelResult | null> {
  const { rows } = await client.query<TaskRow & { from_status: TaskStatus }>(
    `WITH prior AS (
       SELECT id, status AS from_status FROM tasks
        WHERE id = $1 AND status IN ('queued','running')
        FOR UPDATE
     )
     UPDATE tasks SET status = 'cancelled', updated_at = now()
       FROM prior
      WHERE tasks.id = prior.id
     RETURNING tasks.*, prior.from_status`,
    [taskId]
  );
  const row = rows[0];
  if (!row) return null;
  const { from_status, ...taskRow } = row;
  return { row: taskRow as TaskRow, fromStatus: from_status };
}

/** Collect — set-CAS from either terminal outcome (architecture §7). */
export async function collectTask(client: Queryable, taskId: string): Promise<TaskRow | null> {
  const { rows } = await client.query<TaskRow>(
    `UPDATE tasks SET collected = true, updated_at = now()
     WHERE id = $1 AND status IN ('ready','failed') AND NOT collected
     RETURNING *`,
    [taskId]
  );
  return rows[0] ?? null;
}

/** Operator retry — legal only from failed + uncollected; fresh budget. */
export async function operatorRetryTask(client: Queryable, taskId: string): Promise<TaskRow | null> {
  const { rows } = await client.query<TaskRow>(
    `UPDATE tasks SET status='queued', attempts=0, run_after=NULL, enqueued_at=now(), updated_at=now()
     WHERE id=$1 AND status='failed' AND NOT collected
     RETURNING *`,
    [taskId]
  );
  return rows[0] ?? null;
}

/** Boot recovery: running -> queued, no epoch guard needed (no live claimants yet). */
export async function recoveryRequeue(client: Queryable, taskId: string): Promise<TaskRow | null> {
  const { rows } = await client.query<TaskRow>(
    `UPDATE tasks SET status='queued', enqueued_at=now(), run_after=NULL, updated_at=now()
     WHERE id=$1 AND status='running'
     RETURNING *`,
    [taskId]
  );
  return rows[0] ?? null;
}

/** Boot recovery: running -> failed, budget exhausted. */
export async function recoveryFail(
  client: Queryable,
  taskId: string,
  error: { reason: string; retryable: boolean }
): Promise<TaskRow | null> {
  const { rows } = await client.query<TaskRow>(
    `UPDATE tasks SET status='failed', error=$2, updated_at=now()
     WHERE id=$1 AND status='running'
     RETURNING *`,
    [taskId, error]
  );
  return rows[0] ?? null;
}
