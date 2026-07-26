/**
 * Filter parsing shared by the two read paths over `tasks`: the listing
 * (`list.ts`) and the aggregate counts (`counts.ts`).
 *
 * Both MUST read `status`, `from`, and `to` identically — a count that
 * disagrees with the list it opens is a defect, not a rounding error
 * (docs/build-plan.md, "Task counts"). Keeping the parse in one place makes
 * that agreement structural rather than a comment.
 */
import { ValidationError } from "./errors.js";
import type { TaskStatus } from "./types.js";

export const STATUSES: readonly TaskStatus[] = [
  "queued",
  "running",
  "ready",
  "failed",
  "cancelled",
];

/** Validates an optional `?status=` filter value (api-contract §7). */
export function parseStatusFilter(status: string | undefined): TaskStatus | undefined {
  if (status === undefined) return undefined;
  if (!STATUSES.includes(status as TaskStatus)) {
    throw new ValidationError(`invalid status "${status}"`);
  }
  return status as TaskStatus;
}

/** Parses a `?from=` / `?to=` timestamp (api-contract §7). */
export function parseTimestamp(input: string, field: string): Date {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError(`invalid timestamp for "${field}": "${input}"`);
  }
  return d;
}
