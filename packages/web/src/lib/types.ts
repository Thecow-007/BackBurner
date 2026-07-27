/**
 * Shapes the SPA consumes — a faithful mirror of docs/api-contract.md §4/§8
 * and docs/frontend-brief.md §8 (the data digest). This is a PURE API
 * consumer: these types describe what the HTTP/SSE surface returns, nothing
 * about the database or the engine. Every field here is documented in the
 * contract; the SPA treats unknown fields/events forgivingly (contract §1
 * "clients must ignore unknown fields").
 */

export type TaskStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

export interface TaskError {
  reason: string;
  retryable: boolean;
}

/** Mock-worker success payload (frontend-brief §8.1). */
export interface MockResult {
  message: string;
  slept_ms: number;
}

/** The task object (api-contract §4): nine spec fields + four additive. */
export interface Task {
  handle: string;
  lane: string;
  params: Record<string, unknown>;
  status: TaskStatus;
  result: unknown | null;
  error: TaskError | null;
  created_at: string;
  updated_at: string;
  collected: boolean;
  // Additive [EXTENSION] fields.
  id: string;
  attempts: number;
  max_attempts: number;
  seeded: boolean;
}

/**
 * One mock-worker-backed lane's range for an omitted `params.duration_ms`
 * (api-contract §6.2 `lane_defaults`). The submit form's duration helper text
 * is sourced from this and from nothing else — a hard-coded "3–15 s" is wrong
 * on `build` (20–90 s), and a range the client cannot source is a range it must
 * not assert (frontend-brief §6.5).
 */
export interface LaneDefault {
  duration_ms: { min: number; max: number };
}

/**
 * Aggregate counts, an additive `[EXTENSION]` object on the `GET /tasks`
 * response (api-contract §6.2, ADR 0018). Every number the sidebar, the
 * register header and the filter sheet display comes from here — a count
 * derived client-side from a paginated page would be invented state
 * (frontend-brief §6.5), so there is no fallback and no estimate.
 *
 * Each field has a DIFFERENT filter basis, because a count must always match
 * the list it opens:
 *  - `all`         respects from/to; ignores status, lane, uncollected, q
 *  - `matching`    respects every active filter — what the list actually holds
 *  - `uncollected` ready|failed and not collected; respects lane/from/to only
 *                  — it IS the uncollected predicate, so narrowing it by its own
 *                  filter would collapse it to itself the moment it is clicked
 *  - `status.*`    respects lane/from/to/uncollected; ignores the status filter
 *  - `lane.*`      respects status/from/to/uncollected; ignores the lane filter
 *  - `lanes`       the engine's REGISTERED lanes, not a DISTINCT over data,
 *                  so a user with zero tasks still gets a lane picker
 *  - `lane_defaults` ignores every filter; one entry per mock-worker lane
 */
export interface Counts {
  all: number;
  matching: number;
  uncollected: number;
  status: Record<TaskStatus, number>;
  lane: Record<string, number>;
  lanes: string[];
  /** Optional on purpose: a lane backed by a non-mock worker has no range, and
   * a server that omits the field entirely must not break the submit form. */
  lane_defaults?: Record<string, LaneDefault>;
}

/** `GET /tasks` envelope (api-contract §6.2). */
export interface TaskListResponse {
  tasks: Task[];
  as_of: number;
  next_cursor: string | null;
  counts?: Counts;
}

export interface HistoryTransition {
  event_type: string;
  from_status: TaskStatus | null;
  to_status: TaskStatus | null;
  at: string;
  meta: Record<string, unknown>;
}

export interface HistoryResponse {
  transitions: HistoryTransition[];
}

/** Error envelope on every non-2xx (api-contract §3, frontend-brief §8.6). */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    current_status?: TaskStatus;
    lane?: string;
    [key: string]: unknown;
  };
}

// ── SSE events (api-contract §8, frontend-brief §8.4) ──────────────────────
// Every frame carries `type`, `handle`, `lane`, `task_id`, `at`, plus the SSE
// `id:` line (surfaced here as `id`). Extra per-type fields below.

export type EventType =
  | "accepted"
  | "running"
  | "retrying"
  | "ready"
  | "failed"
  | "cancelled"
  | "collected";

/** Common shape carried by every event, plus the numeric SSE id. */
export interface BaseEvent {
  id: number;
  type: EventType;
  handle: string;
  lane: string;
  task_id: string;
  at: string;
  /** Any extra per-type fields (summary/attempt/reason/…) travel here too. */
  [key: string]: unknown;
}

/** A parsed lifecycle event: the base fields plus event-specific extras. */
export interface LifecycleEvent extends BaseEvent {
  summary?: string;
  attempt?: number;
  max_attempts?: number;
  reason?: string;
  retryable?: boolean;
  run_after?: string;
  operator?: boolean;
  recovery?: boolean;
}

// ── SPA-local view models (not from the API) ───────────────────────────────

/** Live connection state shown in the header (frontend-brief §5.4). */
export type ConnectionState =
  | "connecting" // initial subscribe not yet open
  | "live" // healthy
  | "reconnecting" // dropped, auto-recovering
  | "stale"; // stale threshold hit, resync in progress

/** The four mutating actions (frontend-brief §6.4). */
export type PendingAction = "submit" | "cancel" | "retry" | "collect";

/** A completion/failure notice for the toast layer + notification center
 * (frontend-brief §7). Derived from a `ready`/`failed` event. */
export interface NotificationNotice {
  /** The source event id — also the dedupe key so a notice never doubles. */
  eventId: number;
  taskId: string;
  handle: string;
  lane: string;
  kind: "ready" | "failed";
  /** `summary` for ready, `reason` for failed. */
  detail: string;
  /** Present for failed notices. */
  retryable?: boolean;
  at: string;
  read: boolean;
}

/** Dashboard filter/sort selection — maps 1:1 to `GET /tasks` query params
 * (frontend-brief §4.2, §8.2). All optional; absent means "All".
 *
 * `uncollected` is `true` or absent and nothing else, mirroring the wire
 * contract exactly: the server accepts only the literal string `true` and 400s
 * on `false`/`1`/`yes`/empty, because a client that wants the filter off omits
 * the parameter (api-contract §7). Modelling it as `boolean` would invite a
 * `false` that the API rejects. `q` is deliberately NOT here: search is an
 * overlay-local read that never becomes register state (ADR 0027). */
export interface TaskFilters {
  status?: TaskStatus;
  lane?: string;
  from?: string;
  to?: string;
  sort?: string; // `created_at|updated_at` + optional `:asc|:desc`
  uncollected?: true;
}

/** Submit-form payload (frontend-brief §4.3). */
export interface SubmitInput {
  lane: string;
  duration_ms?: number;
  fail?: boolean;
  fail_permanent?: boolean;
  /** Flaky: retryable failure while `attempt <= fail_times`, then success.
   * Integer 1–9 on the wire (api-contract §1); the form keeps it below the
   * attempt budget so the task can actually recover. */
  fail_times?: number;
  max_attempts?: number;
}
