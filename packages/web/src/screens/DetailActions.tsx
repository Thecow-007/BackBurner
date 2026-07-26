/**
 * The detail screen's action bar and its confirmations.
 *
 * Which buttons exist is decided in exactly one place — `allowedActions()` in
 * `lib/matrix.ts` (docs/frontend-brief.md §3). This file writes no
 * `switch (status)` of its own, so the UI can never offer a move the engine
 * would reject, and a change to the matrix reaches every screen at once.
 *
 * Two disciplines are load-bearing here:
 *
 *  1. **Collect is a read that mutates.** `GET /tasks/{handle}/result` flips
 *     `collected`, releases the handle for reuse and emits an event. It fires
 *     only from a labelled press — never a render, an effect, a navigation or a
 *     convenience prefetch (frontend-brief §6.1).
 *  2. **Pending until the confirming EVENT.** A pressed control stays pending
 *     from press until `cancelled` / `retrying` / `collected` applies to the
 *     store — not until the HTTP response returns (ui-spec §0, §3.7). The store
 *     owns the timeout and the resync; this file only renders the state.
 */
import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { Button, type ButtonVariant } from "../components/Button.js";
import { ConfirmCard } from "../components/ConfirmCard.js";
import { ConfirmSheet } from "../components/ConfirmSheet.js";
import { allowedActions } from "../lib/matrix.js";
import type { PendingAction, Task } from "../lib/types.js";
import { useActionError, useActions, useIsPending } from "../store/react.js";
import styles from "./DetailActions.module.css";

export interface DetailActionsProps {
  /** The task the bar acts on. Every action is dispatched by immutable id;
   *  the handle appears only in the confirmation copy, as a display name. */
  task: Task;
}

export interface CollectResultButtonProps {
  task: Task;
}

export interface ActionErrorNoteProps {
  /** Only an error naming THIS task is this screen's to show. */
  taskId: string;
}

/** The desktop inline confirm renders inside the panel; below this the mobile
 * bottom sheet takes over, so a thumb never fires a mutation mid-scroll
 * (ui-spec §3.8). Matches the one-pane breakpoint in ui-spec §2. */
const DESKTOP_CONFIRM = "(min-width: 900px)";

/** ui-spec §3.7: after ten seconds of silence the label admits that the
 * confirming event has not arrived. The store forces its resync on the same
 * deadline, so the two stay in step. */
const STALE_PENDING_MS = 10_000;
const STALE_LABEL = "Waiting for confirmation…";

const PENDING_LABEL: Record<Exclude<PendingAction, "submit">, string> = {
  cancel: "Cancelling…",
  retry: "Retrying…",
  collect: "Collecting…",
};

// ── The bar ─────────────────────────────────────────────────────────────────

/** The two actions that always confirm on this screen. Collect-on-ready and
 * Retry act immediately — the user is looking at the task (ui-spec §3.8). */
type Confirmable = "cancel" | "collect";

interface ConfirmSpec {
  question: ReactNode;
  confirmLabel: string;
  dismissLabel: string;
  confirmVariant: ButtonVariant;
  run: () => void;
}

export function DetailActions({ task }: DetailActionsProps): ReactElement | null {
  const { cancel, retry, collect } = useActions();
  const allowed = allowedActions(task);
  const wide = useWideViewport();
  const [confirming, setConfirming] = useState<Confirmable | null>(null);

  const cancelState = usePendingAction(task.id, "cancel");
  const retryState = usePendingAction(task.id, "retry");
  const collectState = usePendingAction(task.id, "collect");

  // A confirmation outlives the action it guards if the task moves underneath
  // it — press Cancel, the worker finishes first, and the question would still
  // be asking about a running task. The matrix decides; the card follows.
  useEffect(() => {
    if (confirming === "cancel" && !allowed.cancel) setConfirming(null);
    if (confirming === "collect" && !allowed.collect) setConfirming(null);
  }, [confirming, allowed.cancel, allowed.collect]);

  // `failed` is the only status whose collect is an acknowledgement rather than
  // a retrieval, and the matrix already decided the button EXISTS — this only
  // picks its words and its weight. Green belongs to `ready` alone: collecting
  // a ready result is the happy path (ui-spec §1.1).
  const acknowledging = task.status === "failed";

  const spec: ConfirmSpec | null =
    confirming === "cancel"
      ? {
          question: (
            <>
              Cancel <span className={styles.handle}>{task.handle}</span>? A running worker will be
              stopped.
            </>
          ),
          confirmLabel: "Cancel task",
          dismissLabel: "Keep running",
          confirmVariant: "danger",
          run: () => void cancel(task.id),
        }
      : confirming === "collect"
        ? {
            question: (
              <>
                Collect <span className={styles.handle}>{task.handle}</span>? This archives the
                task, frees its handle, and makes Retry unavailable.
              </>
            ),
            confirmLabel: "Collect / acknowledge",
            dismissLabel: "Keep it",
            confirmVariant: "secondary",
            run: () => void collect(task.id),
          }
        : null;

  function dismiss(): void {
    setConfirming(null);
  }

  function confirm(): void {
    setConfirming(null);
    spec?.run();
  }

  // `StatusSlot` already replaces this slot with the terminal note on a
  // terminal task; this is the belt-and-braces case, and it renders nothing
  // rather than an empty bar.
  if (!allowed.cancel && !allowed.retry && !allowed.collect) return null;

  // Desktop: the question replaces the buttons inside the panel, so the task it
  // names stays in view while the operator decides.
  if (wide && spec !== null) {
    return (
      <div className={styles.confirm}>
        <ConfirmCard
          question={spec.question}
          confirmLabel={spec.confirmLabel}
          dismissLabel={spec.dismissLabel}
          confirmVariant={spec.confirmVariant}
          onConfirm={confirm}
          onDismiss={dismiss}
        />
      </div>
    );
  }

  return (
    <>
      <div className={styles.bar}>
        {allowed.retry ? (
          <Button
            className={styles.action}
            variant="danger"
            pending={retryState.pending}
            pendingLabel={retryState.label}
            onClick={() => void retry(task.id)}
          >
            Retry
          </Button>
        ) : null}

        {allowed.collect ? (
          <Button
            className={styles.action}
            variant={acknowledging ? "secondary" : "collect"}
            pending={collectState.pending}
            pendingLabel={collectState.label}
            onClick={acknowledging ? () => setConfirming("collect") : () => void collect(task.id)}
          >
            {acknowledging ? "Collect / acknowledge" : "Collect result"}
          </Button>
        ) : null}

        {allowed.cancel ? (
          <Button
            className={styles.action}
            variant="secondary"
            pending={cancelState.pending}
            pendingLabel={cancelState.label}
            onClick={() => setConfirming("cancel")}
          >
            Cancel
          </Button>
        ) : null}
      </div>

      {spec !== null ? (
        <ConfirmSheet
          open
          question={spec.question}
          confirmLabel={spec.confirmLabel}
          dismissLabel={spec.dismissLabel}
          confirmVariant={spec.confirmVariant}
          onConfirm={confirm}
          onDismiss={dismiss}
        />
      ) : null}
    </>
  );
}

/**
 * The Result-ready panel's single action. Same store call and same pending key
 * as the bar's Collect, so pressing either puts both in the pending state — one
 * action, two affordances, never two independent requests.
 */
export function CollectResultButton({ task }: CollectResultButtonProps): ReactElement | null {
  const { collect } = useActions();
  const state = usePendingAction(task.id, "collect");
  if (!allowedActions(task).collect) return null;

  return (
    <Button
      className={styles.action}
      variant="collect"
      pending={state.pending}
      pendingLabel={state.label}
      onClick={() => void collect(task.id)}
    >
      Collect result
    </Button>
  );
}

/**
 * The stale-action conflict (frontend-brief §4.4). A `409` carries the engine's
 * actual `current_status`, which is more useful than the envelope sentence —
 * and it lives outside the `StatusSlot`'s action area on purpose, because the
 * conflict that retires the last action would otherwise vanish with it.
 */
export function ActionErrorNote({ taskId }: ActionErrorNoteProps): ReactElement | null {
  const error = useActionError();
  const { dismissActionError } = useActions();
  if (error === null || error.taskId !== taskId) return null;

  const message =
    error.currentStatus !== undefined ? `Already ${error.currentStatus}` : error.message;

  return (
    <p className={styles.conflict} role="alert">
      <span>{message}</span>
      <button type="button" className={styles.dismiss} onClick={dismissActionError}>
        dismiss
      </button>
    </p>
  );
}

// ── Hooks ───────────────────────────────────────────────────────────────────

interface PendingState {
  pending: boolean;
  label: string;
}

/** Pending plus its label. True from press until the CONFIRMING EVENT lands. */
function usePendingAction(id: string, action: Exclude<PendingAction, "submit">): PendingState {
  const pending = useIsPending(id, action);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!pending) {
      setStale(false);
      return;
    }
    // Presentational only: a one-shot timer over state the client already
    // holds. It issues nothing and reads nothing — the store's own deadline
    // drives the resync.
    const timer = window.setTimeout(() => setStale(true), STALE_PENDING_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);

  return { pending, label: stale ? STALE_LABEL : PENDING_LABEL[action] };
}

/** Inline confirm card at >= 900px, bottom sheet below it. */
function useWideViewport(): boolean {
  const [wide, setWide] = useState(() => matchDesktop()?.matches ?? true);

  useEffect(() => {
    const query = matchDesktop();
    if (!query) return;
    setWide(query.matches);
    const onChange = (event: MediaQueryListEvent): void => setWide(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return wide;
}

function matchDesktop(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(DESKTOP_CONFIRM);
}
