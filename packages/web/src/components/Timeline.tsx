/**
 * The attempt-grouped state timeline (docs/ui-spec.md §3.5) — the per-item
 * "state history with timestamps" the spec requires, rendered from
 * `GET /tasks/id/{id}/history` and nothing else.
 *
 * Presentational: every value on screen is derived from a transition the engine
 * journaled. Nothing is inferred, nothing is rounded that the engine did not
 * report, and an engine `reason` is NEVER abbreviated or truncated to fit —
 * that is the one thing this product refuses to do (ui-spec §0).
 *
 * Ember appears nowhere here. A node takes the colour of the status the
 * transition moved TO (ui-spec §1.1).
 */
import { useMemo, type ReactElement } from "react";

import { durationBetween, formatDuration, formatTimelineTime } from "../lib/format.js";
import { statusPresentation } from "../lib/status.js";
import type { HistoryTransition, TaskStatus } from "../lib/types.js";
import styles from "./Timeline.module.css";

export interface TimelineProps {
  /** Oldest first, exactly as `GET /tasks/id/{id}/history` returns them. */
  transitions: HistoryTransition[];
  /** The micro-label above the rail, e.g. "TIMELINE · 3 ATTEMPTS" or
   *  "TIMELINE · LIVE". The caller composes it. */
  label?: string;
  /** The clock node timestamps are compared against, so "is this from today?"
   * is a question the caller answers and a test can pin. Defaults to now. */
  now?: number;
}

/** The register's stand-in for "there was no prior status" — the `accepted`
 * row's left-hand side, and any transition whose `from_status` is null. */
const NO_STATUS = "—";

interface TimelineNodeItem {
  transition: HistoryTransition;
  /** Attempt/budget carried forward to this point; null while still unknown. */
  attempt: number | null;
  max: number | null;
  /** Backoff announced by this transition's `meta.run_after`, in ms. */
  waitMs: number | null;
  key: string;
}

interface AttemptGroup {
  attempt: number | null;
  max: number | null;
  nodes: TimelineNodeItem[];
}

export function Timeline({ transitions, label, now }: TimelineProps): ReactElement | null {
  const groups = useMemo(() => buildGroups(transitions), [transitions]);
  if (groups.length === 0) return null;
  const clock = now ?? Date.now();

  return (
    <div className={styles.root}>
      {label !== undefined && label !== "" ? <div className={styles.label}>{label}</div> : null}
      <ol className={styles.groups}>
        {groups.map((group, index) => (
          <AttemptSection
            key={group.nodes[0]?.key ?? `group-${index}`}
            group={group}
            now={clock}
            last={index === groups.length - 1}
          />
        ))}
      </ol>
    </div>
  );
}

function AttemptSection({
  group,
  now,
  last,
}: {
  group: AttemptGroup;
  now: number;
  last: boolean;
}): ReactElement {
  const heading = attemptLabel(group);
  const duration = groupDuration(group.nodes);

  return (
    <li className={styles.group}>
      {heading !== null || duration !== null ? (
        <div className={styles.header}>
          {heading !== null ? <span className={styles.headerLabel}>{heading}</span> : null}
          <span className={styles.rule} aria-hidden="true" />
          {duration !== null ? <span className={styles.headerDuration}>{duration}</span> : null}
        </div>
      ) : null}
      <ol className={styles.nodes}>
        {group.nodes.map((node, index) => (
          <TimelineNode
            key={node.key}
            node={node}
            group={group}
            now={now}
            /*
             * The rail is a line BETWEEN events, so it must stop at the last dot
             * rather than trail off into empty space. "Last" is narrow on
             * purpose: only the final node of the final group, and only when it
             * has no backoff marker hanging below it — a node that is last
             * within an earlier attempt still has the next attempt to connect
             * to, and a node followed by `backoff … — waiting` still has its own
             * dashed segment to reach.
             */
            terminal={last && index === group.nodes.length - 1 && node.waitMs === null}
          />
        ))}
      </ol>
    </li>
  );
}

function TimelineNode({
  node,
  group,
  now,
  terminal,
}: {
  node: TimelineNodeItem;
  group: AttemptGroup;
  now: number;
  terminal: boolean;
}): ReactElement {
  const transition = node.transition;
  // S is the status the transition moved TO. `collected` is the exception: it
  // is a flag flip, not a status change (the journal records ready → ready), so
  // giving it a status colour would draw an operator acknowledgement as though
  // the engine had moved the task. It takes a neutral dot instead, which is
  // also how the design draws it.
  const presentation = statusPresentation(transition.to_status ?? "queued");
  const flagFlip = transition.event_type === "collected";
  const dotColor = flagFlip ? "var(--line-strong)" : presentation.color;
  const dotHalo = flagFlip ? "transparent" : presentation.halo;
  const line = metaLine(transition, node.attempt ?? group.attempt, node.max ?? group.max);

  return (
    <li className={styles.node} data-terminal={terminal ? "true" : undefined}>
      <div className={styles.row}>
        <div className={styles.rail} aria-hidden="true">
          <span
            className={styles.dot}
            style={{ background: dotColor, boxShadow: `0 0 0 3px ${dotHalo}` }}
          />
          {/* No stem below the last dot: a hairline continuing into empty space
              would draw a connection to an event that has not happened. */}
          {terminal ? null : <span className={styles.stem} />}
        </div>
        <div className={`${styles.body}${terminal ? ` ${styles.bodyEnd}` : ""}`}>
          <div className={styles.head}>
            <span className={styles.type}>{transition.event_type}</span>
            {/* `dateTime` carries the exact instant the engine journaled; the
                visible text is the local reading of it, dated whenever it is
                not from today. */}
            <time className={styles.time} dateTime={transition.at}>
              {formatTimelineTime(transition.at, now)}
            </time>
          </div>
          <div className={styles.meta}>{line}</div>
        </div>
      </div>
      {node.waitMs !== null ? (
        <div className={styles.wait}>
          <span className={styles.dash} aria-hidden="true" />
          <span className={styles.waitLabel}>backoff {formatDuration(node.waitMs)} — waiting</span>
        </div>
      ) : null}
    </li>
  );
}

// ── Derivation ──────────────────────────────────────────────────────────────

/**
 * A new attempt group begins at each `running` transition — that claim IS the
 * attempt. Everything before the first claim (`accepted`, and a `cancelled`
 * that beat the dispatcher to it) belongs to the first group rather than
 * forming a headless one of its own.
 */
function buildGroups(transitions: HistoryTransition[]): AttemptGroup[] {
  const groups: AttemptGroup[] = [];
  let leading: TimelineNodeItem[] = [];
  let current: AttemptGroup | null = null;
  let attempt: number | null = null;
  let max: number | null = null;

  for (let index = 0; index < transitions.length; index += 1) {
    const transition = transitions[index];
    if (!transition) continue;
    const meta = transition.meta ?? {};

    // Only `running` and `retrying` carry attempt/budget; every other row
    // inherits the last announced values rather than inventing its own.
    attempt = metaNumber(meta, "attempt") ?? attempt;
    max = metaNumber(meta, "max_attempts") ?? max;

    const node: TimelineNodeItem = {
      transition,
      attempt,
      max,
      waitMs: backoffMs(transition),
      key: `${index}-${transition.event_type}-${transition.at}`,
    };

    if (transition.event_type === "running") {
      current = { attempt, max, nodes: leading };
      leading = [];
      groups.push(current);
    }

    if (current === null) {
      leading.push(node);
      continue;
    }
    current.nodes.push(node);
  }

  // Nothing ever ran (queued → cancelled): the leading rows are the whole list.
  if (leading.length > 0) groups.push({ attempt, max, nodes: leading });
  return groups;
}

function attemptLabel(group: AttemptGroup): string | null {
  if (group.attempt === null) return null;
  return group.max === null ? `ATTEMPT ${group.attempt}` : `ATTEMPT ${group.attempt} OF ${group.max}`;
}

/**
 * The per-attempt duration: the last node's `at` minus the first node's.
 * A group with one node has no measurable span between events yet — an
 * in-flight attempt reading `0.0s` would claim it took no time, so the slot is
 * left empty instead. The live elapsed readout is the detail header's job.
 *
 * `collected` is excluded from the span. It is an operator acknowledgement that
 * can land days after the work finished, not part of the attempt — including it
 * would make an attempt header read `1:02` for a task the detail panel calls
 * `9.8s TOTAL`, which is the same duration measured two different ways.
 */
function groupDuration(nodes: TimelineNodeItem[]): string | null {
  const worked = nodes.filter((node) => node.transition.event_type !== "collected");
  if (worked.length < 2) return null;
  const first = worked[0];
  const last = worked[worked.length - 1];
  if (!first || !last) return null;
  return formatDuration(durationBetween(first.transition.at, last.transition.at, Date.now()));
}

/** The dashed wait between attempts, present only when the engine announced
 * when the retry becomes eligible. */
function backoffMs(transition: HistoryTransition): number | null {
  if (transition.event_type !== "retrying") return null;
  const runAfter = metaString(transition.meta ?? {}, "run_after");
  if (runAfter === null || Number.isNaN(Date.parse(runAfter))) return null;
  const ms = durationBetween(transition.at, runAfter, Date.now());
  return ms > 0 ? ms : null;
}

/**
 * The meta line under each event type. The copy register is exact (ui-spec
 * §3.5): precise, non-generic, never marketing. Where a clause's value is
 * absent from `meta`, the clause is omitted — never filled with a placeholder.
 */
function metaLine(
  transition: HistoryTransition,
  attempt: number | null,
  max: number | null
): string {
  const meta = transition.meta ?? {};

  switch (transition.event_type) {
    case "accepted": {
      const budget = metaNumber(meta, "max_attempts") ?? max;
      const head = arrow(null, "queued");
      return budget === null ? head : `${head} · budget ${budget}`;
    }
    case "running": {
      const n = metaNumber(meta, "attempt") ?? attempt;
      const m = metaNumber(meta, "max_attempts") ?? max;
      if (n === 1) return "queued → running · worker claimed";
      if (n !== null && m !== null && n === m) return "queued → running · final attempt";
      if (n !== null) return `queued → running · attempt ${n}`;
      return "queued → running";
    }
    case "retrying": {
      if (meta["operator"] === true) return "operator retry";
      if (meta["recovery"] === true) return "automatic retry after restart";
      const n = metaNumber(meta, "attempt") ?? attempt;
      const head = arrow(transition.from_status, "queued");
      return n === null ? head : `${head} · attempt ${n}`;
    }
    case "failed": {
      // Verbatim. A reason that does not fit wraps; it is never shortened.
      const reason = metaString(meta, "reason");
      const head = reason === null ? "running → failed" : `running → failed · ${reason}`;

      if (meta["retryable"] === true) return `${head} · retryable`;

      // A non-retryable failure is NOT necessarily an exhausted budget. A
      // `fail_permanent` worker lands in `failed` on attempt 1 with the budget
      // untouched, and saying "budget exhausted" there would assert something
      // the engine never did. Only claim exhaustion when the attempts actually
      // ran out; otherwise say plainly that the engine will not retry it.
      const n = metaNumber(meta, "attempt") ?? attempt;
      const m = metaNumber(meta, "max_attempts") ?? max;
      const exhausted = n !== null && m !== null && n >= m;
      return exhausted ? `${head} · budget exhausted · terminal` : `${head} · not retryable`;
    }
    case "ready": {
      const summary = metaString(meta, "summary");
      return summary === null ? "running → ready" : `running → ready · ${summary}`;
    }
    case "cancelled":
      return arrow(transition.from_status, "cancelled");
    case "collected":
      return "operator collected · handle released";
    default:
      // An event type this build does not know is still something that
      // happened — the contract tells clients to be forgiving, and dropping a
      // journaled transition would be the interface lying by omission.
      return arrow(transition.from_status, transition.to_status ?? NO_STATUS);
  }
}

function arrow(from: TaskStatus | null, to: string): string {
  return `${from ?? NO_STATUS} → ${to}`;
}

function metaNumber(meta: Record<string, unknown>, key: string): number | null {
  const value = meta[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metaString(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
