/**
 * createEngine() wiring — docs/architecture.md §2 (public surface), §7-11
 * (lifecycle, dispatch, cancellation, recovery). This module owns no SQL
 * of its own beyond the submit INSERT; every CAS lives in transitions.ts.
 */
import type { Pool } from "pg";
import { isActiveHandleConflict, lockAllocator, nextHandleNum } from "./allocator.js";
import { resolveBackoffConfig, computeBackoffMs, type BackoffConfig } from "./backoff.js";
import { createPool, withTransaction } from "./db.js";
import { createDispatcher, type ClaimOutcome, type Dispatcher } from "./dispatch.js";
import { InvalidStateError, NotFoundError, UnknownLaneError, ValidationError } from "./errors.js";
import {
  EventBus,
  buildEventPayload,
  createSubscription,
  latestEventId as latestEventIdQuery,
  transitionEventId,
} from "./events.js";
import { getTaskById, getTaskByIdUnscoped, resolveHandle } from "./handle.js";
import { listTasks } from "./list.js";
import { runRecovery } from "./recovery.js";
import { deriveHandle, serializeTask, toIso } from "./serialize.js";
import {
  cancelTask,
  claimQueuedTask,
  collectTask,
  completeFailed,
  completeReady,
  completeRetrying,
  insertTransition,
  operatorRetryTask,
} from "./transitions.js";
import type {
  Engine,
  EngineOptions,
  HistoryTransition,
  Job,
  ListFilters,
  TaskObject,
  TaskRow,
  TaskStatus,
  WorkerResult,
} from "./types.js";

const LANE_NAME_RE = /^[a-z][a-z0-9_-]*$/;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ALLOCATION_ATTEMPTS = 3;
const DEFAULT_DRAIN_TIMEOUT_MS = 30000;
const ARM_EPSILON_MS = 5;

type WorkerOutcome = WorkerResult | { threw: unknown };

export function createEngine(opts: EngineOptions): Engine {
  for (const lane of Object.keys(opts.lanes)) {
    if (!LANE_NAME_RE.test(lane)) {
      throw new Error(
        `createEngine: lane "${lane}" is not a valid lane name (must match ${LANE_NAME_RE.source})`
      );
    }
  }

  const pool: Pool = createPool({ pool: opts.pool, connectionString: opts.connectionString });
  const ownsPool = !opts.pool;
  const lanes = opts.lanes;
  const concurrency = opts.concurrency;
  const backoffConfig: BackoffConfig = resolveBackoffConfig(opts.backoff);
  const bus = new EventBus();

  const controllers = new Map<string, AbortController>();
  const inflight = new Map<string, Promise<void>>();
  let stopped = true; // nothing may claim before start()

  function publishTransition(row: TaskRow, transition: Parameters<typeof buildEventPayload>[0]): void {
    bus.publish({
      id: transitionEventId(transition),
      userId: row.user_id,
      event: buildEventPayload(transition, row),
    });
  }

  // ---- dispatch wiring -----------------------------------------------

  async function claimOnce(): Promise<ClaimOutcome> {
    if (stopped) return "empty";
    if (controllers.size >= concurrency) return "empty";

    const outcome = await withTransaction(pool, async (client) => {
      const claimed = await claimQueuedTask(client);
      if (!claimed) return null;
      const meta = { attempt: claimed.attempts, max_attempts: claimed.max_attempts };
      const transition = await insertTransition(client, {
        taskId: claimed.id,
        userId: claimed.user_id,
        eventType: "running",
        fromStatus: "queued",
        toStatus: "running",
        meta,
      });
      return { row: claimed, transition };
    });

    if (!outcome) return "empty";
    publishTransition(outcome.row, outcome.transition);

    const controller = new AbortController();
    controllers.set(outcome.row.id, controller);
    const promise = runWorker(outcome.row, controller);
    inflight.set(outcome.row.id, promise);

    return "claimed";
  }

  async function armWakeup(): Promise<number | null> {
    const { rows } = await pool.query<{ min_run_after: Date | null; db_now: Date }>(
      `SELECT MIN(run_after) AS min_run_after, now() AS db_now
         FROM tasks WHERE status = 'queued' AND run_after IS NOT NULL AND run_after > now()`
    );
    const row = rows[0];
    if (!row || !row.min_run_after) return null;
    return row.min_run_after.getTime() - row.db_now.getTime() + ARM_EPSILON_MS;
  }

  const dispatcher: Dispatcher = createDispatcher({ claim: claimOnce, armWakeup });

  // ---- worker execution -------------------------------------------------

  async function runWorker(row: TaskRow, controller: AbortController): Promise<void> {
    const attemptsAtClaim = row.attempts;
    const laneConfig = lanes[row.lane];
    const job: Job = { handle: deriveHandle(row.lane, row.handle_num), lane: row.lane, params: row.params };

    let outcome: WorkerOutcome;
    try {
      // laneConfig is guaranteed to exist: the task was only ever queued
      // for a lane present in `lanes` at submit time.
      outcome = await laneConfig!.worker(job, { signal: controller.signal });
    } catch (err) {
      outcome = { threw: err };
    }

    try {
      await settleWorker(row, attemptsAtClaim, outcome, controller);
    } finally {
      controllers.delete(row.id);
      inflight.delete(row.id);
      void dispatcher.trigger(); // 4th trigger (architecture §8) — always, even on discard
    }
  }

  function isAbortOutcome(outcome: WorkerOutcome, controller: AbortController): boolean {
    if (!("threw" in outcome)) return false;
    const err = outcome.threw;
    const namedAbort = err instanceof Error && err.name === "AbortError";
    return namedAbort || controller.signal.aborted;
  }

  async function settleWorker(
    row: TaskRow,
    attemptsAtClaim: number,
    outcome: WorkerOutcome,
    controller: AbortController
  ): Promise<void> {
    if (isAbortOutcome(outcome, controller)) {
      // Stale/aborted settlement — the cancel CAS already owns the state
      // transition. No state write, no event, log only (architecture §10).
      return;
    }

    if ("threw" in outcome) {
      const err = outcome.threw;
      const reason = err instanceof Error ? err.message : String(err);
      await handleFailure(row, attemptsAtClaim, { reason, retryable: true });
      return;
    }

    if (outcome.status === "ready") {
      await handleSuccess(row, attemptsAtClaim, outcome.result ?? null);
      return;
    }

    const error = outcome.error ?? { reason: "worker reported failure with no error detail", retryable: true };
    await handleFailure(row, attemptsAtClaim, error);
  }

  async function handleSuccess(row: TaskRow, attemptsAtClaim: number, result: unknown): Promise<void> {
    const outcome = await withTransaction(pool, async (client) => {
      const updated = await completeReady(client, row.id, attemptsAtClaim, result);
      if (!updated) return null;
      const startedAtMs = updated.started_at?.getTime() ?? updated.updated_at.getTime();
      const elapsedMs = updated.updated_at.getTime() - startedAtMs;
      const summary = `${deriveHandle(updated.lane, updated.handle_num)} finished in ${(elapsedMs / 1000).toFixed(1)}s`;
      const transition = await insertTransition(client, {
        taskId: updated.id,
        userId: updated.user_id,
        eventType: "ready",
        fromStatus: "running",
        toStatus: "ready",
        meta: { summary },
      });
      return { row: updated, transition };
    });
    // Zero rows: stale-completion discard (architecture §10) — silent.
    if (outcome) publishTransition(outcome.row, outcome.transition);
  }

  async function handleFailure(
    row: TaskRow,
    attemptsAtClaim: number,
    error: { reason: string; retryable: boolean }
  ): Promise<void> {
    const budgetRemains = error.retryable && attemptsAtClaim < row.max_attempts;

    if (budgetRemains) {
      const delayMs = computeBackoffMs(attemptsAtClaim, backoffConfig);
      const runAfter = new Date(Date.now() + delayMs);
      const outcome = await withTransaction(pool, async (client) => {
        const updated = await completeRetrying(client, row.id, attemptsAtClaim, error, runAfter);
        if (!updated) return null;
        const meta = {
          attempt: updated.attempts,
          max_attempts: updated.max_attempts,
          reason: error.reason,
          run_after: toIso(updated.run_after ?? runAfter),
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
      if (outcome) publishTransition(outcome.row, outcome.transition);
      return;
    }

    const outcome = await withTransaction(pool, async (client) => {
      const updated = await completeFailed(client, row.id, attemptsAtClaim, error);
      if (!updated) return null;
      const meta = { reason: error.reason, retryable: error.retryable };
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
    if (outcome) publishTransition(outcome.row, outcome.transition);
  }

  // ---- public surface -----------------------------------------------

  function resolveMaxAttempts(lane: string, override?: number): number {
    if (override !== undefined) {
      if (!Number.isInteger(override) || override < 1 || override > 10) {
        throw new ValidationError("max_attempts must be an integer between 1 and 10");
      }
      return override;
    }
    const laneDefault = lanes[lane]?.defaults?.maxAttempts;
    if (laneDefault !== undefined) {
      if (!Number.isInteger(laneDefault) || laneDefault < 1 || laneDefault > 10) {
        throw new ValidationError(`lane "${lane}" default max_attempts must be an integer between 1 and 10`);
      }
      return laneDefault;
    }
    return DEFAULT_MAX_ATTEMPTS;
  }

  async function submit(
    userId: string,
    lane: string,
    params: Record<string, unknown>,
    submitOpts?: { maxAttempts?: number }
  ): Promise<TaskObject> {
    if (!lanes[lane]) throw new UnknownLaneError(lane);
    if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
      throw new ValidationError("params must be an object");
    }
    const safeParams = params ?? {};
    const maxAttempts = resolveMaxAttempts(lane, submitOpts?.maxAttempts);

    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt++) {
      try {
        const outcome = await withTransaction(pool, async (client) => {
          await lockAllocator(client, userId, lane);
          const handleNum = await nextHandleNum(client, userId, lane);
          const { rows } = await client.query<TaskRow>(
            `INSERT INTO tasks (user_id, lane, handle_num, params, status, max_attempts)
             VALUES ($1, $2, $3, $4, 'queued', $5)
             RETURNING *`,
            [userId, lane, handleNum, safeParams, maxAttempts]
          );
          const inserted = rows[0];
          if (!inserted) throw new Error("submit: INSERT ... RETURNING produced no row");
          const handle = deriveHandle(inserted.lane, inserted.handle_num);
          const transition = await insertTransition(client, {
            taskId: inserted.id,
            userId,
            eventType: "accepted",
            fromStatus: null,
            toStatus: "queued",
            meta: { summary: `${handle} queued` },
          });
          return { row: inserted, transition };
        });

        publishTransition(outcome.row, outcome.transition);
        void dispatcher.trigger();
        return serializeTask(outcome.row);
      } catch (err) {
        lastErr = err;
        if (isActiveHandleConflict(err) && attempt < MAX_ALLOCATION_ATTEMPTS - 1) continue;
        throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("submit: handle allocation failed after retries");
  }

  async function list(
    userId: string,
    filters: ListFilters
  ): Promise<{ tasks: TaskObject[]; as_of: number; next_cursor: string | null }> {
    return listTasks(pool, userId, filters);
  }

  async function get(userId: string, ref: { handle: string } | { id: string }): Promise<TaskObject> {
    const row =
      "handle" in ref ? await resolveHandle(pool, userId, ref.handle) : await getTaskById(pool, userId, ref.id);
    return serializeTask(row);
  }

  async function collect(userId: string, handle: string): Promise<TaskObject> {
    const resolved = await resolveHandle(pool, userId, handle);

    if (resolved.status !== "ready" && resolved.status !== "failed") {
      throw new InvalidStateError(resolved.status);
    }
    if (resolved.collected) {
      // Idempotent re-read: the handle still resolves here (we just
      // resolved it), so no new event (architecture §7 / api-contract §6.4).
      return serializeTask(resolved);
    }

    const outcome = await withTransaction(pool, async (client) => {
      const updated = await collectTask(client, resolved.id);
      if (!updated) return null;
      const transition = await insertTransition(client, {
        taskId: updated.id,
        userId,
        eventType: "collected",
        fromStatus: updated.status,
        toStatus: updated.status,
        meta: {},
      });
      return { row: updated, transition };
    });

    if (!outcome) {
      const fresh = await getTaskByIdUnscoped(pool, resolved.id);
      if (fresh && fresh.collected && (fresh.status === "ready" || fresh.status === "failed")) {
        return serializeTask(fresh);
      }
      throw new InvalidStateError(fresh ? fresh.status : resolved.status);
    }

    publishTransition(outcome.row, outcome.transition);
    return serializeTask(outcome.row);
  }

  async function cancel(userId: string, handle: string): Promise<TaskObject> {
    const resolved = await resolveHandle(pool, userId, handle);

    const outcome = await withTransaction(pool, async (client) => {
      const cas = await cancelTask(client, resolved.id);
      if (!cas) return null;
      const transition = await insertTransition(client, {
        taskId: cas.row.id,
        userId,
        eventType: "cancelled",
        fromStatus: cas.fromStatus,
        toStatus: "cancelled",
        meta: {},
      });
      return { row: cas.row, transition, fromStatus: cas.fromStatus };
    });

    if (!outcome) {
      const fresh = await getTaskByIdUnscoped(pool, resolved.id);
      throw new InvalidStateError(fresh ? fresh.status : resolved.status);
    }

    publishTransition(outcome.row, outcome.transition);

    // CAS-first-then-abort (architecture §10): the state is already
    // committed as cancelled; abort is best-effort signalling only.
    if (outcome.fromStatus === "running") {
      controllers.get(outcome.row.id)?.abort();
    }
    void dispatcher.trigger();

    return serializeTask(outcome.row);
  }

  async function retry(userId: string, handle: string): Promise<TaskObject> {
    const resolved = await resolveHandle(pool, userId, handle);

    const outcome = await withTransaction(pool, async (client) => {
      const updated = await operatorRetryTask(client, resolved.id);
      if (!updated) return null;
      const meta = { attempt: updated.attempts, max_attempts: updated.max_attempts, operator: true };
      const transition = await insertTransition(client, {
        taskId: updated.id,
        userId,
        eventType: "retrying",
        fromStatus: "failed",
        toStatus: "queued",
        meta,
      });
      return { row: updated, transition };
    });

    if (!outcome) {
      const fresh = await getTaskByIdUnscoped(pool, resolved.id);
      throw new InvalidStateError(fresh ? fresh.status : resolved.status);
    }

    publishTransition(outcome.row, outcome.transition);
    void dispatcher.trigger();
    return serializeTask(outcome.row);
  }

  async function history(userId: string, taskId: string): Promise<{ transitions: HistoryTransition[] }> {
    await getTaskById(pool, userId, taskId); // ownership + existence check -> NotFoundError
    const { rows } = await pool.query<{
      event_type: string;
      from_status: TaskStatus | null;
      to_status: TaskStatus | null;
      at: Date;
      meta: Record<string, unknown>;
    }>(
      `SELECT event_type, from_status, to_status, at, meta
         FROM task_transitions WHERE task_id = $1 AND user_id = $2
        ORDER BY id`,
      [taskId, userId]
    );
    return {
      transitions: rows.map((row) => ({
        event_type: row.event_type,
        from_status: row.from_status,
        to_status: row.to_status,
        at: toIso(row.at),
        meta: row.meta,
      })),
    };
  }

  function subscribe(userId: string, sinceId?: number): AsyncIterable<{ id: number; event: Record<string, unknown> }> {
    return createSubscription(bus, pool, userId, sinceId ?? 0);
  }

  async function latestEventId(userId: string): Promise<number> {
    return latestEventIdQuery(pool, userId);
  }

  async function start(): Promise<void> {
    stopped = false;
    await runRecovery(pool, bus);
    await dispatcher.trigger();
  }

  async function stop(stopOpts?: { drain?: boolean; drainTimeoutMs?: number }): Promise<void> {
    stopped = true;
    dispatcher.cancelTimer();

    if (stopOpts?.drain) {
      const timeoutMs = stopOpts.drainTimeoutMs ?? opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
      const pending = [...inflight.values()];
      if (pending.length > 0) {
        let timedOut = false;
        await Promise.race([
          Promise.all(pending).then(() => undefined),
          new Promise<void>((resolve) => {
            setTimeout(() => {
              timedOut = true;
              resolve();
            }, timeoutMs);
          }),
        ]);
        if (timedOut) {
          for (const controller of controllers.values()) controller.abort();
        }
      }
    }

    if (ownsPool) {
      try {
        await pool.end();
      } catch {
        // best-effort cleanup only
      }
    }
  }

  return {
    start,
    stop,
    submit,
    list,
    get,
    collect,
    cancel,
    retry,
    history,
    subscribe,
    latestEventId,
  };
}
