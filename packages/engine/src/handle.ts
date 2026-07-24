/**
 * Handle parsing + resolution — docs/architecture.md §5,
 * docs/api-contract.md §5. Active holder wins; else the most recent
 * former holder; else NotFoundError. Split on the LAST hyphen so lane
 * names may themselves contain hyphens (api-contract §5's lane grammar
 * `^[a-z][a-z0-9_-]*$` permits it).
 */
import { NotFoundError } from "./errors.js";
import { ACTIVE_PREDICATE, type Queryable } from "./transitions.js";
import type { TaskRow } from "./types.js";

export interface ParsedHandle {
  lane: string;
  num: number;
}

const NUM_RE = /^[1-9][0-9]*$/;

export function parseHandle(handle: string): ParsedHandle | null {
  const idx = handle.lastIndexOf("-");
  if (idx <= 0 || idx === handle.length - 1) return null;
  const lane = handle.slice(0, idx);
  const numStr = handle.slice(idx + 1);
  if (!NUM_RE.test(numStr)) return null;
  return { lane, num: Number(numStr) };
}

/**
 * Resolve a `{handle}` path parameter to its owning task for `userId`.
 * Throws NotFoundError when unparseable or nothing ever held the handle.
 */
export async function resolveHandle(
  client: Queryable,
  userId: string,
  handle: string
): Promise<TaskRow> {
  const parsed = parseHandle(handle);
  if (!parsed) throw new NotFoundError(`"${handle}" is not a valid handle`);

  const active = await client.query<TaskRow>(
    `SELECT * FROM tasks
      WHERE user_id = $1 AND lane = $2 AND handle_num = $3 AND ${ACTIVE_PREDICATE}
      LIMIT 1`,
    [userId, parsed.lane, parsed.num]
  );
  if (active.rows[0]) return active.rows[0];

  const former = await client.query<TaskRow>(
    `SELECT * FROM tasks
      WHERE user_id = $1 AND lane = $2 AND handle_num = $3
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [userId, parsed.lane, parsed.num]
  );
  if (former.rows[0]) return former.rows[0];

  throw new NotFoundError(`no task has ever held handle "${handle}"`);
}

export async function getTaskById(
  client: Queryable,
  userId: string,
  taskId: string
): Promise<TaskRow> {
  const { rows } = await client.query<TaskRow>(
    `SELECT * FROM tasks WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [taskId, userId]
  );
  const row = rows[0];
  if (!row) throw new NotFoundError(`no task with id "${taskId}"`);
  return row;
}

/** Re-fetch by id without the user scope check — used internally after a CAS race. */
export async function getTaskByIdUnscoped(client: Queryable, taskId: string): Promise<TaskRow | null> {
  const { rows } = await client.query<TaskRow>(`SELECT * FROM tasks WHERE id = $1 LIMIT 1`, [taskId]);
  return rows[0] ?? null;
}
