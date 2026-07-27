/**
 * Pure filter/sort logic for the dashboard list (docs/frontend-brief.md §4.2).
 * The server does the authoritative filtering/sorting/pagination on each
 * snapshot; these client-side mirrors keep the live list a true answer to the
 * active filter as SSE events mutate rows between snapshots — a task that
 * transitions out of the active status filter must leave the visible list
 * immediately, and a newly-`accepted` task that matches must slot in at the
 * right sort position.
 */
import type { Task, TaskFilters } from "./types.js";

export type SortField = "created_at" | "updated_at";
export type SortDir = "asc" | "desc";

export interface ParsedSort {
  field: SortField;
  dir: SortDir;
}

/** `created_at|updated_at` optionally `:asc|:desc`; default `created_at:desc`
 * (api-contract §7). Unrecognized input falls back to the default. */
export function parseSort(sort: string | undefined): ParsedSort {
  const match = /^(created_at|updated_at)(?::(asc|desc))?$/.exec(sort ?? "");
  if (!match) return { field: "created_at", dir: "desc" };
  return { field: match[1] as SortField, dir: (match[2] as SortDir | undefined) ?? "desc" };
}

/**
 * `status IN ('ready','failed') AND collected = false` — the EXACT predicate
 * behind both `?uncollected=true` and `counts.uncollected` (api-contract §7).
 * It is written once and read by the filter mirror below and by `adjustCounts`,
 * for the same reason the engine parses it once in its own `filters.ts`: a
 * count that disagrees with the list it opens is the specific bug ui-spec §3.10
 * names.
 */
export function isUncollected(task: Task): boolean {
  return (task.status === "ready" || task.status === "failed") && !task.collected;
}

/** Does a task belong in the list for these filters? `from` is inclusive and
 * `to` exclusive on `created_at`, matching the server (api-contract §7). */
export function matchesFilters(task: Task, filters: TaskFilters): boolean {
  if (filters.status !== undefined && task.status !== filters.status) return false;
  if (filters.lane !== undefined && task.lane !== filters.lane) return false;
  // Mirrors the server predicate exactly, so a task leaving the uncollected set
  // disappears from the live list the moment its `collected` event lands.
  if (filters.uncollected === true && !isUncollected(task)) return false;
  if (filters.from !== undefined) {
    const from = Date.parse(filters.from);
    if (!Number.isNaN(from) && Date.parse(task.created_at) < from) return false;
  }
  if (filters.to !== undefined) {
    const to = Date.parse(filters.to);
    if (!Number.isNaN(to) && Date.parse(task.created_at) >= to) return false;
  }
  return true;
}

/** Total order matching the server's: by the sort field, ties broken by `id`
 * in the same direction, so ordering is stable (api-contract §7). UUIDv7 ids
 * sort lexicographically in creation order, so `id` is a valid time-like
 * tiebreak. */
export function compareTasks(a: Task, b: Task, sort: ParsedSort): number {
  const av = sort.field === "created_at" ? a.created_at : a.updated_at;
  const bv = sort.field === "created_at" ? b.created_at : b.updated_at;
  let cmp = av < bv ? -1 : av > bv ? 1 : 0;
  if (cmp === 0) cmp = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return sort.dir === "desc" ? -cmp : cmp;
}

/** Sort a list of task ids by looking each up in `byId`. Ids missing from the
 * map are dropped (they were removed between computing order and rendering). */
export function sortIds(ids: Iterable<string>, byId: Map<string, Task>, sort: ParsedSort): string[] {
  const present: Task[] = [];
  for (const id of ids) {
    const t = byId.get(id);
    if (t) present.push(t);
  }
  present.sort((a, b) => compareTasks(a, b, sort));
  return present.map((t) => t.id);
}
