/**
 * A single completion/failure toast (docs/ui-spec.md §3.11 gallery,
 * frontend-brief §7). Presentational: the notice and both callbacks arrive as
 * props, and the toast layer owns stacking, ordering and placement.
 *
 * Tapping the body OPENS the task. It never collects it: collect is a read
 * that mutates — it flips `collected` and releases the handle — so it may only
 * ever fire from an explicit, labelled press (CLAUDE.md, ui-spec §3.8).
 */
import { useEffect, useRef, useState, type ReactElement } from "react";

import { statusPresentation } from "../lib/status.js";
import type { NotificationNotice } from "../lib/types.js";
import styles from "./Toast.module.css";

export interface ToastProps {
  notice: NotificationNotice;
  /** Tapping the body opens the task. It must NEVER collect it. */
  onOpen(taskId: string): void;
  onDismiss(eventId: number): void;
  /** Ready toasts auto-dismiss after ~6s; failures persist until dismissed. */
  autoDismissMs?: number;
}

const READY_AUTO_DISMISS_MS = 6000;

export function Toast({ notice, onOpen, onDismiss, autoDismissMs }: ToastProps): ReactElement {
  const ready = notice.kind === "ready";
  // A failure never disappears on its own, whatever the caller passes: a
  // missed failure is a task the operator never learns about.
  const dismissAfterMs = ready ? (autoDismissMs ?? READY_AUTO_DISMISS_MS) : 0;
  const [remainingMs, setRemainingMs] = useState(dismissAfterMs);

  // The timer is armed once per notice. Keeping the callback in a ref means a
  // caller that re-creates `onDismiss` each render cannot restart the clock
  // forever and leave the toast on screen.
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (dismissAfterMs <= 0) return;
    const startedAt = Date.now();
    setRemainingMs(dismissAfterMs);
    const expiry = window.setTimeout(() => dismissRef.current(notice.eventId), dismissAfterMs);
    const tick = window.setInterval(() => {
      setRemainingMs(Math.max(0, dismissAfterMs - (Date.now() - startedAt)));
    }, 1000);
    return () => {
      window.clearTimeout(expiry);
      window.clearInterval(tick);
    };
  }, [dismissAfterMs, notice.eventId]);

  const presentation = statusPresentation(notice.kind);

  return (
    <div
      className={`${styles.toast} ${ready ? styles.ready : styles.failed}`}
      role={ready ? "status" : "alert"}
      aria-live={ready ? "polite" : "assertive"}
    >
      <button type="button" className={styles.body} onClick={() => onOpen(notice.taskId)}>
        <span className={styles.glyph} style={{ color: presentation.color }} aria-hidden="true">
          {presentation.glyph}
        </span>
        <span className={styles.lines}>
          <span className={styles.title}>
            <span className={styles.handle}>{notice.handle}</span> {ready ? "finished" : "failed"}
          </span>
          {/* Engine text, verbatim — a failure reason wraps, it is never cut. */}
          <span className={styles.detail}>
            {notice.detail}
            {ready ? " · tap to open" : null}
          </span>
          {!ready && notice.retryable !== undefined ? (
            <span className={styles.flag}>
              {notice.retryable ? "retryable" : "not retryable"}
            </span>
          ) : null}
        </span>
      </button>
      <div className={styles.aside}>
        {dismissAfterMs > 0 ? (
          <span className={styles.countdown} aria-hidden="true">
            {Math.ceil(remainingMs / 1000)}s
          </span>
        ) : null}
        {/* Sibling of the body button, not nested inside it: dismissing must
            never also open the task. */}
        <button
          type="button"
          className={styles.dismiss}
          onClick={() => onDismiss(notice.eventId)}
          aria-label={`Dismiss notification for ${notice.handle}`}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
