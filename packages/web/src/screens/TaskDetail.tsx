/**
 * The task detail screen — `/task/:id`, keyed by the IMMUTABLE id and never by
 * the handle, because handles recycle and a link must never come to mean a
 * different task later (docs/frontend-brief.md §2, §5.2).
 *
 * Everything on screen is either a field the API returned or a value derived
 * from one by `lib/status.ts` / `lib/format.ts`. Nothing is inferred: no
 * progress, no queue position, no truncated error, no status the engine did not
 * announce (docs/ui-spec.md §0).
 *
 * Reads happen exactly once, on mount, and are navigation-driven — not polling.
 * After that the store's SSE stream keeps the task and its timeline current
 * (frontend-brief §5 rule 4), so there is no interval, no refetch-on-focus, no
 * refetch-on-event and no refresh control anywhere in this file.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";

import { Button } from "../components/Button.js";
import { CollectedMarker } from "../components/CollectedMarker.js";
import { EmptyState } from "../components/EmptyState.js";
import { JsonPanel } from "../components/JsonPanel.js";
import { Panel } from "../components/Panel.js";
import { SeedBadge } from "../components/SeedBadge.js";
import { SkeletonRows } from "../components/SkeletonRows.js";
import { StatusChip } from "../components/StatusChip.js";
import { StatusSlot } from "../components/StatusSlot.js";
import { Timeline } from "../components/Timeline.js";
import { formatAbsolute, formatAttempts, formatRelative } from "../lib/format.js";
import { allowedActions } from "../lib/matrix.js";
import { durationReadout, isLive } from "../lib/status.js";
import type { HistoryTransition, Task } from "../lib/types.js";
import { useActions, useHistory, useNow, useTask } from "../store/react.js";
import { ActionErrorNote, CollectResultButton, DetailActions } from "./DetailActions.js";
import styles from "./TaskDetail.module.css";

export interface TaskDetailProps {
  /** The immutable task id from /task/:id. Never a handle. */
  id: string;
  /** Rendered at < 1280px as the `← Register` affordance. Absent at three
   *  panes, where the register is always visible beside this pane. */
  onBack?: () => void;
}

/** The four screen states of frontend-brief §4.4. `loadDetail` rejects and
 * writes no error state of its own, so this screen owns them. */
type Phase = "loading" | "ready" | "notFound" | "error";

/** Relative supplements need a clock, but they change slowly — a half-minute
 * tick is enough, and it costs nothing over the wire (this is a re-render of a
 * number the client already holds, not a read). */
const RELATIVE_TICK_MS = 30_000;

export function TaskDetail({ id, onBack }: TaskDetailProps): ReactElement {
  const { loadDetail } = useActions();
  const task = useTask(id);
  const transitions = useHistory(id);
  const now = useNow(true, RELATIVE_TICK_MS);

  const [phase, setPhase] = useState<Phase>("loading");
  const [loadError, setLoadError] = useState("");
  // Bumped by the error state's Retry, which re-issues the mount fetch and
  // nothing else. There is no other path back into this effect.
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setPhase("loading");
    setLoadError("");
    loadDetail(id).then(
      () => {
        if (live) setPhase("ready");
      },
      (err: unknown) => {
        if (!live) return;
        const failure = describeFailure(err);
        setPhase(failure.notFound ? "notFound" : "error");
        setLoadError(failure.message);
      }
    );
    return () => {
      live = false;
    };
  }, [id, loadDetail, reloadNonce]);

  const retryLoad = useCallback(() => setReloadNonce((n) => n + 1), []);

  // The `collected` transition's instant, for the state note. Absent from the
  // history means the note DROPS the clause — it never invents a time.
  const collectedAt = useMemo(() => collectedInstant(transitions), [transitions]);
  const completedAt = useMemo(() => completedInstant(transitions), [transitions]);

  const back =
    onBack === undefined ? null : (
      <button type="button" className={styles.back} onClick={onBack}>
        ← Register
      </button>
    );

  if (phase === "notFound") {
    return (
      <div className={styles.screen}>
        {back}
        <EmptyState
          heading="No task with this id."
          body="This address does not resolve to a task on your key. Handles recycle, but ids never do — so a link that once worked still points at the same task, or at nothing."
          action={
            // A client-side navigation, not an <a href="/">: a full reload here
            // would tear down the stream and re-run the whole hydrate handshake
            // just to move between two screens of the same app.
            onBack === undefined ? null : (
              <button type="button" className={styles.backLink} onClick={onBack}>
                Back to the register
              </button>
            )
          }
        />
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className={styles.screen}>
        {back}
        <Panel tone="error" label="Could not load this task">
          <p className={styles.reason}>{loadError}</p>
          <div className={styles.errorActions}>
            <Button variant="secondary" onClick={retryLoad}>
              Retry
            </Button>
          </div>
        </Panel>
      </div>
    );
  }

  // Skeleton only while there is genuinely nothing to show. Arriving from the
  // register, the store already holds this task — every field of it announced
  // by the engine — and replacing real state with a placeholder would be a
  // regression, not a loading state.
  if (task === undefined) {
    return (
      <div className={styles.screen}>
        {back}
        <p className="sr-only" role="status">
          Loading task…
        </p>
        <div className={styles.identity} aria-hidden="true">
          <SkeletonRows rows={3} bars={3} />
        </div>
      </div>
    );
  }

  const readout = durationReadout(task);
  const actions = allowedActions(task);
  // The serializer nulls `error` off a non-failed task, but the store applies
  // events on top of the last fetch and a `retrying` event moves the task back
  // to `queued` without clearing the error it carried. Both conditions, then.
  const failure = task.status === "failed" ? task.error : null;

  return (
    <div className={styles.screen}>
      {back}

      <header className={styles.identity}>
        <div className={styles.handleRow}>
          <h1 className={styles.handle}>{task.handle}</h1>
          {/* Collected and cancelled chips read back at .72 — the same mute the
           * duration readout takes, from the same derivation, so the header can
           * never disagree with itself. There is no sixth status. */}
          <StatusChip status={task.status} size="detail" muted={readout.muted} />
          {task.collected ? <CollectedMarker /> : null}
          {task.seeded ? <SeedBadge /> : null}
        </div>
        <div className={styles.idRow}>
          {/* The immutable id: what scripts, links and event correlation use. */}
          <span className={styles.id}>{task.id}</span>
          <CopyButton value={task.id} label="Copy task id" />
        </div>
      </header>

      <div className={styles.slotFrame}>
        <StatusSlot
          task={task}
          collectedAt={collectedAt}
          completedAt={completedAt}
          actions={<DetailActions task={task} />}
        />
      </div>

      <ActionErrorNote taskId={task.id} />

      {/* The one block that still speaks in UTC — demoted, not dropped. The
       * human reading of the instant leads, because that is the clock an
       * operator reads the screen in; the exact `Z` string stays underneath it,
       * selectable and copyable, because that is what an operator correlating
       * with a server log has to paste. */}
      <dl className={styles.meta}>
        <div className={styles.metaItem}>
          <dt className={styles.metaTerm}>lane</dt>
          <dd className={styles.metaValue}>{task.lane}</dd>
        </div>
        <div className={styles.metaItem}>
          <dt className={styles.metaTerm}>attempts</dt>
          <dd className={styles.metaValue}>
            {formatAttempts(task.attempts, task.max_attempts, task.status)}
          </dd>
        </div>
        <Stamp term="created" iso={task.created_at} now={now} />
        <Stamp term="updated" iso={task.updated_at} now={now} />
      </dl>

      {/* Verbatim, wrapping, never truncated, and identical whether or not the
       * task has been collected — collecting acknowledges a failure, it does
       * not hide it (frontend-brief §4.4). */}
      {failure !== null ? (
        <Panel
          tone="error"
          label="Error — verbatim"
          headerRight={<span className={styles.retryable}>retryable: {String(failure.retryable)}</span>}
        >
          <p className={styles.reason}>{failure.reason}</p>
          {actions.retry ? (
            <p className={styles.aside}>
              The engine will not retry this on its own; Retry restarts it with a fresh attempt
              budget.
            </p>
          ) : null}
        </Panel>
      ) : null}

      <section className={styles.block}>
        <JsonPanel label="PARAMS" value={task.params} collapsible />
      </section>

      {task.status === "ready" ? (
        task.collected ? (
          <section className={styles.block}>
            <JsonPanel label="RESULT" value={task.result} collapsible />
          </section>
        ) : (
          /* The payload is revealed BY collecting, not before. Collect is a
           * read that mutates — it frees the handle and emits an event — so it
           * fires only from this labelled press (frontend-brief §6.1). */
          <Panel label="Result ready" headerRight={<span className={styles.held}>held</span>}>
            <p className={styles.aside}>
              The worker finished and the payload is waiting. Collecting reveals it, releases{" "}
              <span className={styles.handleInline}>{task.handle}</span> for reuse, and archives the
              task.
            </p>
            <div className={styles.resultAction}>
              <CollectResultButton task={task} />
            </div>
          </Panel>
        )
      ) : null}

      <section className={styles.block}>
        {/* The same ticking clock the relative supplements use, so the timeline
         * can tell a transition from today apart from a seeded one months old
         * and date the latter. */}
        <Timeline transitions={transitions ?? []} label={timelineLabel(task)} now={now} />
      </section>
    </div>
  );
}

// ── Local pieces ────────────────────────────────────────────────────────────

/**
 * A `created` / `updated` entry: the human absolute plus its relative
 * supplement on the first line, the engine's exact ISO instant on the second.
 *
 * Both lines are `<time>` elements carrying the same machine-readable
 * `dateTime`, so nothing about the timestamp is only available visually — and
 * the `Z` string is rendered verbatim, never reformatted, because a value
 * pasted into a log query has to match what the API said character for
 * character.
 */
function Stamp({ term, iso, now }: { term: string; iso: string; now: number }): ReactElement {
  return (
    <div className={styles.metaItem}>
      <dt className={styles.metaTerm}>{term}</dt>
      <dd className={`${styles.metaValue} ${styles.stamp}`}>
        <span className={styles.stampHuman}>
          <time dateTime={iso}>{formatAbsolute(iso)}</time>
          <span className={styles.relative}> · {formatRelative(iso, now)}</span>
        </span>
        <span className={styles.stampInstant}>
          <time className={styles.instant} dateTime={iso}>
            {iso}
          </time>
          <CopyButton
            value={iso}
            label={`Copy the ${term} timestamp`}
            className={styles.copyQuiet}
          />
        </span>
      </dd>
    </div>
  );
}

const CONFIRM_MS = 1500;

type CopyState = "idle" | "copied" | "failed";

const COPY_LABEL: Record<CopyState, string> = {
  idle: "copy",
  copied: "copied",
  // A dead button is not honest: a refused clipboard write says so.
  failed: "copy failed",
};

function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  /** The timestamps take a quieter variant — same control, less furniture. */
  className?: string;
}): ReactElement {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  function copy(): void {
    const clipboard = navigator.clipboard;
    const flash = (next: CopyState): void => {
      setState(next);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setState("idle"), CONFIRM_MS);
    };
    if (!clipboard) {
      flash("failed");
      return;
    }
    clipboard.writeText(value).then(
      () => flash("copied"),
      () => flash("failed")
    );
  }

  return (
    // The visible word changes to confirm; the accessible name does not, so a
    // screen reader is never told the button is called "copied".
    <button
      type="button"
      className={[styles.copy, className].filter(Boolean).join(" ")}
      onClick={copy}
      aria-label={label}
    >
      {COPY_LABEL[state]}
    </button>
  );
}

// ── Derivation ──────────────────────────────────────────────────────────────

/** The `collected` transition's instant, or undefined when the history holds
 * none — the state note then omits the clause rather than inventing a time. */
function collectedInstant(transitions: HistoryTransition[] | undefined): string | undefined {
  if (transitions === undefined) return undefined;
  for (let index = transitions.length - 1; index >= 0; index -= 1) {
    const transition = transitions[index];
    if (transition?.event_type === "collected") return transition.at;
  }
  return undefined;
}

/** When the work actually finished. `updated_at` cannot answer this once a task
 * has been collected, because collecting moves it — see `durationReadout`. */
function completedInstant(transitions: HistoryTransition[] | undefined): string | undefined {
  if (transitions === undefined) return undefined;
  for (let index = transitions.length - 1; index >= 0; index -= 1) {
    const transition = transitions[index];
    if (transition?.event_type === "ready" || transition?.event_type === "failed") {
      return transition.at;
    }
  }
  return undefined;
}

/** `TIMELINE · LIVE` while the engine may still act, otherwise the attempt
 * count. Zero attempts (a queued task that never ran) gets neither. */
function timelineLabel(task: Task): string {
  if (isLive(task)) return "TIMELINE · LIVE";
  if (task.attempts === 1) return "TIMELINE · 1 ATTEMPT";
  if (task.attempts > 1) return `TIMELINE · ${task.attempts} ATTEMPTS`;
  return "TIMELINE";
}

interface LoadFailure {
  notFound: boolean;
  message: string;
}

/**
 * Read the rejection without importing the HTTP layer: this screen is a store
 * consumer and has no business holding a reference to the API client.
 *
 * A malformed id answers `400 invalid_params` and an unknown or foreign one
 * answers `404 not_found` — either way no task exists at this address, so the
 * two are one screen state (frontend-brief §4.4).
 */
function describeFailure(err: unknown): LoadFailure {
  const rejection = err as { status?: unknown; code?: unknown; message?: unknown } | null;
  const status = typeof rejection?.status === "number" ? rejection.status : 0;
  const code = typeof rejection?.code === "string" ? rejection.code : "";
  const message =
    typeof rejection?.message === "string" && rejection.message.length > 0
      ? rejection.message
      : "Could not reach the server.";
  return {
    notFound: status === 404 || (status === 400 && code === "invalid_params"),
    message,
  };
}
