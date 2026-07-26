/**
 * GET /tasks listing — docs/api-contract.md §7. Filters, sort, keyset
 * pagination, and `as_of` (computed strictly before the tasks query so it
 * may only under-state the snapshot, never over-state it — architecture
 * §11 / api-contract §7).
 */
import type { Pool } from "pg";
import { ValidationError } from "./errors.js";
import { latestEventId } from "./events.js";
import { parseStatusFilter, parseTimestamp } from "./filters.js";
import { serializeTask, toIso } from "./serialize.js";
import type { ListFilters, TaskObject, TaskRow } from "./types.js";

const SORT_FIELDS = ["created_at", "updated_at"] as const;
type SortField = (typeof SORT_FIELDS)[number];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface CursorPayload {
  v: string; // ISO timestamp of the sort field on the last row of the previous page
  id: string; // tiebreak — task uuid (uuidv7, so lexicographic order matches time order)
}

function parseSort(sort: string | undefined): { field: SortField; dir: "asc" | "desc" } {
  if (sort === undefined) return { field: "created_at", dir: "desc" };
  const match = /^(created_at|updated_at)(?::(asc|desc))?$/.exec(sort);
  if (!match) throw new ValidationError(`invalid sort "${sort}"`);
  const field = match[1] as SortField;
  const dir = (match[2] as "asc" | "desc" | undefined) ?? "desc";
  return { field, dir };
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { v?: unknown }).v !== "string" ||
      typeof (parsed as { id?: unknown }).id !== "string"
    ) {
      throw new Error("malformed cursor payload");
    }
    return parsed as CursorPayload;
  } catch {
    throw new ValidationError(`invalid cursor "${cursor}"`);
  }
}

export async function listTasks(
  pool: Pool,
  userId: string,
  filters: ListFilters
): Promise<{ tasks: TaskObject[]; as_of: number; next_cursor: string | null }> {
  const status = parseStatusFilter(filters.status);
  const fromDate = filters.from !== undefined ? parseTimestamp(filters.from, "from") : undefined;
  const toDate = filters.to !== undefined ? parseTimestamp(filters.to, "to") : undefined;
  const { field, dir } = parseSort(filters.sort);

  const limit = filters.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ValidationError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  const cursor = filters.cursor !== undefined ? decodeCursor(filters.cursor) : undefined;

  // as_of BEFORE the tasks query — may under-state, must never over-state.
  const as_of = await latestEventId(pool, userId);

  const conditions: string[] = ["user_id = $1"];
  const values: unknown[] = [userId];

  if (status !== undefined) {
    values.push(status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.lane !== undefined) {
    values.push(filters.lane);
    conditions.push(`lane = $${values.length}`);
  }
  if (fromDate !== undefined) {
    values.push(fromDate);
    conditions.push(`created_at >= $${values.length}`);
  }
  if (toDate !== undefined) {
    values.push(toDate);
    conditions.push(`created_at < $${values.length}`);
  }
  if (cursor !== undefined) {
    const cmp = dir === "desc" ? "<" : ">";
    values.push(cursor.v, cursor.id);
    const vIdx = values.length - 1;
    const idIdx = values.length;
    conditions.push(`(${field}, id) ${cmp} ($${vIdx}::timestamptz, $${idIdx}::uuid)`);
  }

  const orderDir = dir === "desc" ? "DESC" : "ASC";
  values.push(limit + 1);
  const sql = `SELECT * FROM tasks WHERE ${conditions.join(" AND ")} ORDER BY ${field} ${orderDir}, id ${orderDir} LIMIT $${values.length}`;

  const { rows } = await pool.query<TaskRow>(sql, values);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  let next_cursor: string | null = null;
  if (hasMore) {
    const last = pageRows[pageRows.length - 1];
    if (last) {
      const v = field === "created_at" ? toIso(last.created_at) : toIso(last.updated_at);
      next_cursor = encodeCursor({ v, id: last.id });
    }
  }

  return { tasks: pageRows.map(serializeTask), as_of, next_cursor };
}
