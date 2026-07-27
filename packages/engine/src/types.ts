/**
 * Public types for @backburner/engine — docs/architecture.md §2, §8;
 * docs/api-contract.md §4. This file is the source of truth for the shapes
 * re-exported from index.ts; nothing here reaches into HTTP concerns.
 */
import type { Pool } from "pg";

export interface Job {
  handle: string;
  lane: string;
  params: Record<string, unknown>;
}

export interface WorkerResult {
  status: "ready" | "failed";
  result?: unknown;
  error?: { reason: string; retryable: boolean };
}

export interface WorkerContext {
  signal: AbortSignal;
  /**
   * 1-based attempt number for this claim. [EXTENSION] Identical to the
   * `attempt` the engine journals onto the `running` transition for the same
   * claim, so what a worker sees and what the history endpoint reports can
   * never diverge.
   */
  attempt: number;
  /** The task's attempt budget (`max_attempts`). [EXTENSION] */
  maxAttempts: number;
}

export type Worker = (job: Job, ctx: WorkerContext) => Promise<WorkerResult>;

export interface LaneConfig {
  worker: Worker;
  defaults?: { maxAttempts?: number };
}

export interface BackoffOptions {
  baseMs?: number;
  rng?: () => number;
}

export interface EngineOptions {
  pool?: Pool;
  connectionString?: string;
  concurrency: number;
  lanes: Record<string, LaneConfig>;
  backoff?: BackoffOptions;
  /**
   * [ADDITIVE — see final report item (d)] Default drain window (ms) for
   * `stop({ drain: true })` when the call site doesn't override it —
   * architecture §13's `DRAIN_TIMEOUT_MS` (default 30000). The engine
   * never reads `process.env` itself; the caller reads `DRAIN_TIMEOUT_MS`
   * and passes it through here (or per-call via `stop()`'s own opts).
   */
  drainTimeoutMs?: number;
}

export type TaskStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

export interface TaskObject {
  handle: string;
  lane: string;
  params: Record<string, unknown>;
  status: TaskStatus;
  result: unknown | null;
  error: { reason: string; retryable: boolean } | null;
  created_at: string;
  updated_at: string;
  collected: boolean;
  id: string;
  attempts: number;
  max_attempts: number;
  seeded: boolean;
}

export interface ListFilters {
  status?: string;
  lane?: string;
  from?: string;
  to?: string;
  sort?: string;
  limit?: number;
  cursor?: string;
  /**
   * [EXTENSION] Raw `?uncollected=` value. The only accepted value is the
   * string `"true"`; anything else is a `ValidationError`. When present the
   * read is restricted to `status IN ('ready','failed') AND collected = false`
   * — deliberately the exact predicate behind `counts.uncollected`.
   */
  uncollected?: string;
  /**
   * [EXTENSION] Raw `?q=` free-text lookup over handle and id. 1-64 chars
   * after trimming. Rank-ordered and unpaginated; conflicts with `sort` and
   * `cursor` (api-contract §7).
   */
  q?: string;
}

/**
 * Aggregate counts for one user's tasks — api-contract §6.2's `counts`
 * object ([EXTENSION]). Each field has its own filter basis; see the table
 * in `counts.ts` and the contract. Invariants the implementation guarantees:
 * `status` always carries all five keys (zero-valued when empty),
 * `sum(status.*) === all` whenever no `lane` filter is active, and `lane`
 * carries one key per registered lane (zero-valued when empty).
 */
export interface TaskCounts {
  /** Respects `from`/`to` only — the register's grand total. */
  all: number;
  /** Respects every active filter — the "N tasks" the current view lists. */
  matching: number;
  /** `status IN ('ready','failed') AND collected = false`; respects `lane`/`from`/`to`. */
  uncollected: number;
  /** Per status; respects `lane`/`from`/`to`, ignores `status`. */
  status: Record<TaskStatus, number>;
  /** Per lane; respects `status`/`from`/`to`, ignores `lane`. */
  lane: Record<string, number>;
  /** Lanes REGISTERED with `createEngine`, in registration order. Not data. */
  lanes: string[];
}

export interface HistoryTransition {
  event_type: string;
  from_status: TaskStatus | null;
  to_status: TaskStatus | null;
  at: string;
  meta: Record<string, unknown>;
}

export interface Engine {
  start(): Promise<void>;
  stop(opts?: { drain?: boolean; drainTimeoutMs?: number }): Promise<void>;
  submit(
    userId: string,
    lane: string,
    params: Record<string, unknown>,
    opts?: { maxAttempts?: number }
  ): Promise<TaskObject>;
  list(
    userId: string,
    filters: ListFilters
  ): Promise<{ tasks: TaskObject[]; as_of: number; next_cursor: string | null }>;
  counts(userId: string, filters: ListFilters): Promise<TaskCounts>;
  get(userId: string, ref: { handle: string } | { id: string }): Promise<TaskObject>;
  collect(userId: string, handle: string): Promise<TaskObject>;
  cancel(userId: string, handle: string): Promise<TaskObject>;
  retry(userId: string, handle: string): Promise<TaskObject>;
  history(userId: string, taskId: string): Promise<{ transitions: HistoryTransition[] }>;
  subscribe(userId: string, sinceId?: number): AsyncIterable<{ id: number; event: Record<string, unknown> }>;
  latestEventId(userId: string): Promise<number>;
}

/**
 * Internal row shape as returned by `SELECT * FROM tasks` (snake_case
 * columns, pg's native JS types). Not part of the public surface — the
 * serializer maps this to TaskObject.
 */
export interface TaskRow {
  id: string;
  user_id: string;
  lane: string;
  handle_num: number;
  params: Record<string, unknown>;
  status: TaskStatus;
  result: unknown | null;
  error: { reason: string; retryable: boolean } | null;
  attempts: number;
  max_attempts: number;
  collected: boolean;
  seeded: boolean;
  enqueued_at: Date;
  run_after: Date | null;
  started_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface TransitionRow {
  id: string | number; // bigint arrives as string from pg
  task_id: string;
  user_id: string;
  event_type: string;
  from_status: TaskStatus | null;
  to_status: TaskStatus | null;
  at: Date;
  meta: Record<string, unknown>;
}
