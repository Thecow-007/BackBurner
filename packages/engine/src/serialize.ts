/**
 * Task row -> public TaskObject. docs/api-contract.md §4: `result` visible
 * only when ready, `error` visible only when failed; `handle` is always
 * derived, never stored; timestamps are ISO-8601 UTC with `Z`.
 */
import type { TaskObject, TaskRow } from "./types.js";

export function deriveHandle(lane: string, handleNum: number): string {
  return `${lane}-${handleNum}`;
}

export function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function serializeTask(row: TaskRow): TaskObject {
  return {
    handle: deriveHandle(row.lane, row.handle_num),
    lane: row.lane,
    params: row.params ?? {},
    status: row.status,
    result: row.status === "ready" ? (row.result ?? null) : null,
    error: row.status === "failed" ? (row.error ?? null) : null,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    collected: row.collected,
    id: row.id,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    seeded: row.seeded,
  };
}
