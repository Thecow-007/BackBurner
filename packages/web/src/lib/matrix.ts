/**
 * The status → allowed-actions matrix (docs/frontend-brief.md §3). ONE
 * canonical function drives every action button in the app, so the UI never
 * offers a move the engine would reject. Pure — no rendering, no side effects.
 */
import type { Task } from "./types.js";

export interface AllowedActions {
  collect: boolean;
  cancel: boolean;
  retry: boolean;
}

const NONE: AllowedActions = { collect: false, cancel: false, retry: false };

export function allowedActions(task: Task): AllowedActions {
  switch (task.status) {
    case "queued":
    case "running":
      // Cancel is the only move; it releases the handle.
      return { collect: false, cancel: true, retry: false };
    case "ready":
      // Collect is the only release path for ready work, and only once.
      return { collect: !task.collected, cancel: false, retry: false };
    case "failed":
      // Uncollected: retry (fresh budget) OR collect/acknowledge. Collecting
      // permanently retires retry. Cancel never applies — it already stopped.
      return { collect: !task.collected, cancel: false, retry: !task.collected };
    case "cancelled":
      return NONE;
    default:
      return NONE;
  }
}
