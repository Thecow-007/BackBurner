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
  /** Overrides the per-kind default below. `0` means "never auto-dismiss". */
  autoDismissMs?: number;
}

const READY_AUTO_DISMISS_MS = 6000;
/**
 * A failure gets 15s — two and a half times a success, and long enough to read
 * a wrapped engine reason — and then clears itself (ADR 0023).
 *
 * `frontend-brief.md` §7.1 originally said a failed toast "persists until
 * dismissed". The assessment spec requires only that a finished job surface a
 * notification with no action from the user; nothing requires persistence, and
 * the notification centre remains the durable session record either way. What
 * persistence actually produced was a stack of red cards the operator had to
 * clear by hand.
 */
const FAILED_AUTO_DISMISS_MS = 15_000;
/** Fine enough that a hover-paused countdown resumes without a visible jump. */
const TICK_MS = 500;

export function Toast({ notice, onOpen, onDismiss, autoDismissMs }: ToastProps): ReactElement {
  const ready = notice.kind === "ready";
  const dismissAfterMs =
    autoDismissMs ?? (ready ? READY_AUTO_DISMISS_MS : FAILED_AUTO_DISMISS_MS);
  const [remainingMs, setRemainingMs] = useState(dismissAfterMs);
  // A notice must not vanish out from under someone reading it, so the clock
  // stops while the toast is hovered or holds keyboard focus, and resumes with
  // whatever time was left (ADR 0023).
  const [held, setHeld] = useState(false);
  const remainingRef = useRef(dismissAfterMs);

  // The timer is armed once per notice. Keeping the callback in a ref means a
  // caller that re-creates `onDismiss` each render cannot restart the clock
  // forever and leave the toast on screen.
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    remainingRef.current = dismissAfterMs;
    setRemainingMs(dismissAfterMs);
  }, [dismissAfterMs, notice.eventId]);

  useEffect(() => {
    if (dismissAfterMs <= 0 || held) return;
    const budget = remainingRef.current;
    if (budget <= 0) return;
    const startedAt = Date.now();
    const left = (): number => Math.max(0, budget - (Date.now() - startedAt));
    const expiry = window.setTimeout(() => dismissRef.current(notice.eventId), budget);
    const tick = window.setInterval(() => {
      remainingRef.current = left();
      setRemainingMs(remainingRef.current);
    }, TICK_MS);
    return () => {
      window.clearTimeout(expiry);
      window.clearInterval(tick);
      // Banked, so resuming picks up where the pause began rather than
      // restarting the full countdown.
      remainingRef.current = left();
    };
  }, [dismissAfterMs, held, notice.eventId]);

  const presentation = statusPresentation(notice.kind);

  return (
    <div
      className={`${styles.toast} ${ready ? styles.ready : styles.failed}`}
      role={ready ? "status" : "alert"}
      aria-live={ready ? "polite" : "assertive"}
      data-held={held ? "true" : undefined}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      // React's onFocus/onBlur are focusin/focusout, so they fire for the body
      // and dismiss buttons inside — tabbing to a toast holds it open.
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
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
