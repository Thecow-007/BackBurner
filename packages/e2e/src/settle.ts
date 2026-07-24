import { cancel, listTasks, type TaskObject } from "./api.js";
import type { EventCapture } from "./events.js";
import type { ServerHandle } from "./server.js";
import { T_EVENT } from "./timing.js";

export interface SettleOptions {
  /** Attached to any wait-timeout error for diagnosability. */
  server?: ServerHandle;
  /** Per-cancellation wait bound for the `cancelled` event. Default `T_EVENT`. */
  timeoutMs?: number;
}

async function listAllActive(baseUrl: string, key: string): Promise<TaskObject[]> {
  const active: TaskObject[] = [];
  let cursor: string | undefined;
  for (;;) {
    const res = await listTasks(baseUrl, key, { limit: 200, cursor });
    if (res.status !== 200) {
      throw new Error(
        `settle: GET /tasks failed with status ${res.status}: ${JSON.stringify(res.body)}`
      );
    }
    const body = res.body as { tasks: TaskObject[]; next_cursor: string | null };
    for (const task of body.tasks) {
      if (task.status === "queued" || task.status === "running") {
        active.push(task);
      }
    }
    if (!body.next_cursor) break;
    cursor = body.next_cursor;
  }
  return active;
}

/**
 * `settle()` (test-plan.md §3.2): used by supplemental suites — one server
 * per file — before each `beforeEach` truncation. Cancels every `queued`/
 * `running` task through the API; a `409` is a benign completion race (the
 * task reached a terminal state between listing and cancel) and is not an
 * error. Waits for the corresponding `cancelled` event, correlated by
 * `task_id` (never by handle), only for the calls that actually returned
 * `200` — proving the worker pool is provably idle before the tables are
 * truncated. Never collects anything: finished-but-uncollected tasks
 * (`ready`/`failed`) hold no worker and are left exactly as they are, to be
 * cleared by the truncation itself.
 */
export async function settle(
  baseUrl: string,
  key: string,
  events: EventCapture,
  options: SettleOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? T_EVENT;
  const targets = await listAllActive(baseUrl, key);

  const waits: Promise<unknown>[] = [];
  for (const task of targets) {
    const res = await cancel(baseUrl, key, task.handle);
    if (res.status === 200) {
      waits.push(
        events.waitFor(
          (e) => e.type === "cancelled" && e.task_id === task.id,
          timeoutMs,
          `settle: cancelled for ${task.handle} (task_id=${task.id})`,
          options.server
        )
      );
    } else if (res.status !== 409) {
      throw new Error(
        `settle: unexpected cancel status ${res.status} for ${task.handle}: ${JSON.stringify(res.body)}`
      );
    }
    // 409 => the task reached a terminal state between listing and cancel
    // (test-plan.md §3.2) — benign, nothing to wait for.
  }

  await Promise.all(waits);
}
