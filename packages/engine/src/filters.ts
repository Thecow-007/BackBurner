/**
 * Filter parsing shared by the two read paths over `tasks`: the listing
 * (`list.ts`) and the aggregate counts (`counts.ts`).
 *
 * Both MUST read `status`, `from`, `to`, `uncollected`, and `q` identically —
 * a count that disagrees with the list it opens is a defect, not a rounding
 * error (docs/build-plan.md, "Task counts"). Keeping the parse *and* the SQL
 * fragments in one place makes that agreement structural rather than a
 * comment. `uncollected` in particular is the exact predicate behind
 * `counts.uncollected`, so the filter and the number that opens it are the
 * same string of SQL, not two hand-copied ones.
 */
import { ValidationError } from "./errors.js";
import type { ListFilters, TaskStatus } from "./types.js";

export const STATUSES: readonly TaskStatus[] = [
  "queued",
  "running",
  "ready",
  "failed",
  "cancelled",
];

/**
 * The one definition of "finished but still waiting for an operator", used
 * by the `uncollected` count AND the `?uncollected=true` filter.
 */
export const UNCOLLECTED_PREDICATE = "status IN ('ready','failed') AND collected = false";

/**
 * The one definition of "still holds its handle" — architecture §6's active
 * set. Used only for `?q=` ranking, where a live `scrape-1` must outrank a
 * released former holder of the same name.
 */
export const HOLDS_HANDLE_PREDICATE =
  "(status IN ('queued','running') OR (status IN ('ready','failed') AND collected = false))";

/** The derived handle, in SQL. Handles are never stored as a string
 * (architecture §5) — `lane + "-" + handle_num` is built wherever it is
 * needed, here as in `serialize.ts`. */
export const HANDLE_SQL = "lower(lane || '-' || handle_num::text)";

/** Maximum length of a `?q=` term after trimming (api-contract §7). */
export const MAX_Q_LENGTH = 64;

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

/**
 * Parses `?uncollected=` (api-contract §7, [EXTENSION]). The only accepted
 * value is the literal string `true`; `false`, `1`, `yes` and the empty
 * string are all rejected rather than read as "off", because §7's rule is
 * that an invalid value is a `400` — never silently ignored or clamped. A
 * client that wants the filter off omits the parameter.
 */
export function parseUncollectedFilter(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value !== "true") {
    throw new ValidationError(
      `invalid uncollected "${value}": the only accepted value is "true" (omit the parameter to disable the filter)`
    );
  }
  return true;
}

/**
 * Escapes the `LIKE` metacharacters in a user-supplied prefix. The backslash
 * itself goes first, or it would double-escape the escapes added after it.
 */
export function escapeLikePrefix(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Parses `?q=` (api-contract §7, [EXTENSION]) and enforces its two mutual
 * exclusions. `q` orders by relevance; `sort` and `cursor` order by time.
 * Two different orderings cannot both be in effect, and silently picking one
 * would be a lie about what the client asked for — so the combination is a
 * `400` naming the conflict, not a precedence rule.
 *
 * Returned lowercased and trimmed: matching is case-insensitive, and the SQL
 * side lowercases the columns it compares against.
 */
export function parseSearchFilter(filters: ListFilters): string | undefined {
  if (filters.q === undefined) return undefined;

  if (filters.cursor !== undefined) {
    throw new ValidationError(
      '"q" cannot be combined with "cursor": search results are rank-ordered and unpaginated (next_cursor is always null)'
    );
  }
  if (filters.sort !== undefined) {
    throw new ValidationError(
      '"q" cannot be combined with "sort": search results are ranked by relevance, which is a different ordering than sort requests'
    );
  }

  const trimmed = filters.q.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_Q_LENGTH) {
    throw new ValidationError(
      `"q" must be between 1 and ${MAX_Q_LENGTH} characters after trimming (got ${trimmed.length})`
    );
  }
  return trimmed.toLowerCase();
}

/**
 * The `?q=` match predicate, as SQL. A task matches when its handle or its
 * id equals `q`, or when either *starts with* `q` — so `q=scrape` returns
 * every scrape and `q=scrape-1` returns `scrape-1`, `scrape-10`, `scrape-19`.
 *
 * Appends its two bound values to `values` and returns the SQL fragment,
 * so callers cannot get the parameter numbering out of step with the text.
 */
export function buildSearchMatch(q: string, values: unknown[]): string {
  values.push(q);
  const exactIdx = values.length;
  values.push(`${escapeLikePrefix(q)}%`);
  const prefixIdx = values.length;
  return (
    `(${HANDLE_SQL} = $${exactIdx} OR id::text = $${exactIdx}` +
    ` OR ${HANDLE_SQL} LIKE $${prefixIdx} ESCAPE '\\'` +
    ` OR id::text LIKE $${prefixIdx} ESCAPE '\\')`
  );
}

/** The exact-match half of the search predicate — the top rank tier. */
export function buildSearchExact(q: string, values: unknown[]): string {
  values.push(q);
  const idx = values.length;
  return `(${HANDLE_SQL} = $${idx} OR id::text = $${idx})`;
}
