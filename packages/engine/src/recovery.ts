/**
 * Boot recovery — docs/architecture.md §11 "Boot recovery". Every row
 * stranded in `running` when the process last died is repaired: budget
 * remaining -> requeue with a journaled `retrying` (meta.recovery=true);
 * budget exhausted -> `failed` with the honest interrupted-by-restart
 * reason. Each repair is an ordinary CAS that tolerates zero rows (some
 * other actor already resolved the row between the scan and the repair).
 */
import type { Pool } from "pg";
import { withTransaction } from "./db.js";
import { buildEventPayload, transitionEventId, type EventBus } from "./events.js";
import { insertTransition, recoveryFail, recoveryRequeue } from "./transitions.js";
import type { TaskRow } from "./types.js";

const INTERRUPTED_ERROR = {
  reason: "interrupted by restart; attempt budget exhausted",
  retryable: false,
} as const;

export async function runRecovery(pool: Pool, bus: EventBus): Promise<void> {
  const { rows } = await pool.query<TaskRow>(`SELECT * FROM tasks WHERE status = 'running'`);

  for (const row of rows) {
    if (row.attempts < row.max_attempts) {
      const outcome = await withTransaction(pool, async (client) => {
        const updated = await recoveryRequeue(client, row.id);
        if (!updated) return null;
        const meta = {
          recovery: true,
          attempt: updated.attempts,
          max_attempts: updated.max_attempts,
        };
        const transition = await insertTransition(client, {
          taskId: updated.id,
          userId: updated.user_id,
          eventType: "retrying",
          fromStatus: "running",
          toStatus: "queued",
          meta,
        });
        return { row: updated, transition };
      });
      if (outcome) {
        bus.publish({
          id: transitionEventId(outcome.transition),
          userId: outcome.row.user_id,
          event: buildEventPayload(outcome.transition, outcome.row),
        });
      }
    } else {
      const outcome = await withTransaction(pool, async (client) => {
        const updated = await recoveryFail(client, row.id, INTERRUPTED_ERROR);
        if (!updated) return null;
        const meta = { reason: INTERRUPTED_ERROR.reason, retryable: INTERRUPTED_ERROR.retryable };
        const transition = await insertTransition(client, {
          taskId: updated.id,
          userId: updated.user_id,
          eventType: "failed",
          fromStatus: "running",
          toStatus: "failed",
          meta,
        });
        return { row: updated, transition };
      });
      if (outcome) {
        bus.publish({
          id: transitionEventId(outcome.transition),
          userId: outcome.row.user_id,
          event: buildEventPayload(outcome.transition, outcome.row),
        });
      }
    }
  }
}
