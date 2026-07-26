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

/** `GET /tasks` envelope (api-contract §6.2). */
export interface TaskListResponse {
  tasks: Task[];
  as_of: number;
  next_cursor: string | null;
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
 * (frontend-brief §4.2). All optional; absent means "All". */
export interface TaskFilters {
  status?: TaskStatus;
  lane?: string;
  from?: string;
  to?: string;
  sort?: string; // `created_at|updated_at` + optional `:asc|:desc`
}

/** Submit-form payload (frontend-brief §4.3). */
export interface SubmitInput {
  lane: string;
  duration_ms?: number;
  fail?: boolean;
  fail_permanent?: boolean;
  max_attempts?: number;
}
