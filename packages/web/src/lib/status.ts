/**
 * The single source for how a status LOOKS and what its duration slot says
 * (docs/ui-spec.md §1.1, §3.1, §3.6, §5). Pairs with `matrix.ts`, which is the
 * single source for what a status PERMITS. Between them no screen ever writes
 * its own `switch (status)`.
 *
 * Pure — no rendering, no side effects, no colour literals (every colour is a
 * token name resolved in `theme/tokens.css`).
 */
import type { Task, TaskStatus } from "./types.js";

export interface StatusPresentation {
  status: TaskStatus;
  /** Verbatim from the API. Never paraphrased, never colour-alone (ui-spec §3.1). */
  label: string;
  /** Leading glyph inside the chip, so status never depends on colour. */
  glyph: string;
  /** The status colour, as a CSS custom-property reference. */
  color: string;
  /** Chip fill + border. Running is the exception: a solid fill with dark text. */
  chipBg: string;
  chipBorder: string;
  chipText: string;
  /** Timeline node halo — `box-shadow: 0 0 0 3px <halo>`. */
  halo: string;
  /** Running is the only variant that animates (ui-spec §1.3). */
  animated: boolean;
  /** Live rows carry the blue gutter rail and the faint wash (ui-spec §3.4). */
  live: boolean;
}

const PRESENTATION: Record<TaskStatus, StatusPresentation> = {
  queued: {
    status: "queued",
    label: "queued",
    glyph: "·",
    color: "var(--st-queued)",
    chipBg: "var(--chip-queued-bg)",
    chipBorder: "var(--chip-queued-border)",
    chipText: "var(--st-queued)",
    halo: "var(--halo-queued)",
    animated: false,
    live: true,
  },
  running: {
    status: "running",
    label: "running",
    glyph: "▸",
    color: "var(--st-running)",
    chipBg: "var(--chip-running-bg)",
    chipBorder: "var(--chip-running-bg)",
    chipText: "var(--chip-running-text)",
    halo: "var(--halo-running)",
    animated: true,
    live: true,
  },
  ready: {
    status: "ready",
    label: "ready",
    glyph: "✓",
    color: "var(--st-ready)",
    chipBg: "var(--chip-ready-bg)",
    chipBorder: "var(--chip-ready-border)",
    chipText: "var(--st-ready)",
    halo: "var(--halo-ready)",
    animated: false,
    live: false,
  },
  failed: {
    status: "failed",
    label: "failed",
    glyph: "✕",
    color: "var(--st-failed)",
    chipBg: "var(--chip-failed-bg)",
    chipBorder: "var(--chip-failed-border)",
    chipText: "var(--st-failed)",
    halo: "var(--halo-failed)",
    animated: false,
    live: false,
  },
  cancelled: {
    status: "cancelled",
    label: "cancelled",
    glyph: "⊘",
    color: "var(--st-cancelled)",
    chipBg: "var(--chip-cancelled-bg)",
    chipBorder: "var(--chip-cancelled-border)",
    chipText: "var(--st-cancelled)",
    halo: "var(--halo-cancelled)",
    animated: false,
    live: false,
  },
};

/** There is no sixth status. A collected task keeps its chip and gains the
 * `collected` marker beside it (ui-spec §3.1, §3.2). */
export function statusPresentation(status: TaskStatus): StatusPresentation {
  return PRESENTATION[status] ?? PRESENTATION.queued;
}

/** The five statuses in the order the sidebar and filter rail list them. */
export const STATUS_ORDER: readonly TaskStatus[] = [
  "queued",
  "running",
  "ready",
  "failed",
  "cancelled",
] as const;

/** A task is "live" while the engine may still act on it — the rows that get
 * the blue rail and, on mobile, sit under the LIVE group header. */
export function isLive(task: Task): boolean {
  return task.status === "queued" || task.status === "running";
}

// ── The duration slot (ui-spec §3.6) ────────────────────────────────────────

export interface DurationReadout {
  /** ISO instant the duration is measured FROM. */
  since: string;
  /** ISO instant it is measured TO — null means "now", and it ticks. */
  until: string | null;
  /** Ticks client-side. Presentational only; this is not polling (ui-spec §5). */
  live: boolean;
  /** The changing label under the number: WAITING / ELAPSED / TOTAL / … */
  label: string;
  /** Collected and cancelled readouts render at reduced opacity. */
  muted: boolean;
  /** Replaces the action bar when no action remains (ui-spec §3.6). */
  terminalNote: string | null;
}

/**
 * The slot ALWAYS holds a duration, in the status colour, with a changing
 * label — so the panel never jumps between states.
 *
 * `completedAt` is the instant the work actually finished, taken from the
 * `ready`/`failed` transition in the task's history. It matters because
 * `updated_at` moves when a task is COLLECTED, and collecting is an operator
 * action that can happen days later: measuring to `updated_at` made a task read
 * `6.9s TOTAL` before collection and `27.5s TOTAL` after, as though clicking a
 * button had changed how long the worker ran. Where history is not loaded the
 * caller omits it and `updated_at` is used, which is exact for every
 * uncollected task — the only case a duration is shown without history.
 */
export function durationReadout(task: Task, completedAt?: string): DurationReadout {
  const finished = task.collected && completedAt !== undefined ? completedAt : task.updated_at;
  const base = { since: task.created_at, until: finished, live: false, muted: false };
  switch (task.status) {
    case "queued":
      return { ...base, until: null, live: true, label: "WAITING", terminalNote: null };
    case "running":
      // Elapsed since the worker claimed it — that claim is the last transition.
      return { ...base, since: task.updated_at, until: null, live: true, label: "ELAPSED", terminalNote: null };
    case "ready":
      return {
        ...base,
        label: "TOTAL",
        muted: task.collected,
        terminalNote: task.collected ? "terminal · view only" : null,
      };
    case "failed":
      return {
        ...base,
        label: `ACROSS ${task.attempts} ${task.attempts === 1 ? "ATTEMPT" : "ATTEMPTS"}`,
        muted: task.collected,
        terminalNote: task.collected ? "terminal · view only" : null,
      };
    case "cancelled":
      return { ...base, label: "BEFORE CANCEL", muted: true, terminalNote: "terminal · view only" };
    default:
      return { ...base, label: "TOTAL", terminalNote: null };
  }
}

/**
 * The one-line state note under the duration slot (ui-spec §3.6 gallery).
 * Every clause is sourced from the task object — nothing is inferred.
 *
 * `collectedAt` comes from the `collected` transition in the task's history and
 * is optional: list rows do not have history loaded, so they pass nothing and
 * the timestamp clause is simply omitted rather than invented.
 */
export function stateNote(task: Task, collectedAt?: string): string {
  switch (task.status) {
    case "queued":
      // The design read "queued behind N tasks", but queue POSITION is not
      // derivable from any endpoint — see docs/ui-spec.md §7. Budget only.
      return `attempt budget ${task.max_attempts}`;
    case "running":
      return `attempt ${task.attempts} / ${task.max_attempts} · worker claimed ${clockOf(task.updated_at)}`;
    // The word "collected" is carried by the CollectedMarker beside the note in
    // every surface that has one (rows, cards, the detail header), so the note
    // itself only says it when it can add something the marker cannot — the
    // time, which is only known where history is loaded. Otherwise the register
    // reads "collected  collected · handle released".
    case "ready":
      if (!task.collected) return "result held until you collect · handle still leased";
      return collectedAt
        ? `collected ${clockOf(collectedAt)} · handle released · result shown below`
        : "handle released · result shown below";
    case "failed":
      if (task.collected) {
        return collectedAt
          ? `collected ${clockOf(collectedAt)} · retry permanently retired · error still shown`
          : "retry permanently retired · error still shown";
      }
      // These two are NOT the same failure, and the error panel prints
      // `retryable` directly beside this line — so saying "not retryable" for a
      // retryable error that merely ran out of budget puts a visible
      // contradiction on screen. A retryable failure that exhausted its budget
      // is done because the attempts ran out, not because the error was fatal.
      if (task.error?.retryable === false) return "not retryable by the engine";
      return task.attempts >= task.max_attempts
        ? "budget exhausted · the engine will not retry it again"
        : "the engine will not retry it again";
    case "cancelled":
      return "operator cancelled · worker aborted · handle released";
    default:
      return "";
  }
}

function clockOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
