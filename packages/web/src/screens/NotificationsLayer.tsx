/**
 * The notification layer (docs/frontend-brief.md §7): transient toasts plus the
 * notification centre. Both live outside routing — there is no
 * `/notifications` URL — because a notice is an interruption of whatever you
 * were doing, not a place you navigate to (docs/ui-spec.md §7).
 *
 * Two rules do the load-bearing work here:
 *
 *  - A notice fires on the FIRST APPLICATION of a `ready` or `failed` event to
 *    the store, including events recovered by replay after a reconnect — those
 *    are genuinely news to the user. Deduplication by event id (in the store,
 *    and again by `useToastQueue`) guarantees a toast never fires twice for the
 *    same event, so a reconnect storm cannot produce a wall of duplicates.
 *
 *  - Tapping a notice OPENS the task. It never collects it. Collect is a read
 *    that mutates — it releases the handle — so it fires only from an explicit,
 *    labelled press (§6.1).
 */
import { useEffect, useRef, type ReactElement } from "react";

import { Button } from "../components/Button.js";
import { StatusChip } from "../components/StatusChip.js";
import { Toast } from "../components/Toast.js";
import { formatRelative } from "../lib/format.js";
import {
  useActions,
  useNotifications,
  useNow,
  useToastQueue,
} from "../store/react.js";
import styles from "./NotificationsLayer.module.css";

/** Newest on top, the rest queue (frontend-brief §7.1). */
const MAX_VISIBLE_TOASTS = 3;
const READY_TOAST_MS = 6000;
/** A failure gets two and a half times as long as a success and then clears
 * itself; the notification centre below keeps it for the session either way
 * (ADR 0023 — a departure from frontend-brief §7.1's "persists until
 * dismissed", which that section now records). */
const FAILED_TOAST_MS = 15_000;

export interface NotificationsLayerProps {
  /** Whether the notification centre is open. The shell owns this state. */
  open: boolean;
  onClose(): void;
  /** Navigate to a task's detail screen. The router owns navigation. */
  onOpenTask(taskId: string): void;
}

export function NotificationsLayer({
  open,
  onClose,
  onOpenTask,
}: NotificationsLayerProps): ReactElement {
  return (
    <>
      <ToastStack onOpenTask={onOpenTask} />
      {open ? <NotificationCentre onClose={onClose} onOpenTask={onOpenTask} /> : null}
    </>
  );
}

function ToastStack({ onOpenTask }: { onOpenTask: (taskId: string) => void }): ReactElement | null {
  const { pending, markShown } = useToastQueue();
  if (pending.length === 0) return null;

  const visible = pending.slice(0, MAX_VISIBLE_TOASTS);

  return (
    <div className={styles.toasts}>
      {visible.map((notice) => (
        <Toast
          key={notice.eventId}
          notice={notice}
          // Both kinds clear themselves; the failure simply gets longer on
          // screen. Stated at the call site rather than left to the component's
          // default, so the two durations are visible in one place.
          autoDismissMs={notice.kind === "ready" ? READY_TOAST_MS : FAILED_TOAST_MS}
          onOpen={(taskId) => {
            markShown(notice.eventId);
            onOpenTask(taskId);
          }}
          onDismiss={markShown}
        />
      ))}
    </div>
  );
}

function NotificationCentre({
  onClose,
  onOpenTask,
}: {
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
}): ReactElement {
  const notices = useNotifications();
  const { markNotificationsRead, clearNotifications } = useActions();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const now = useNow(true, 30_000);

  // Opening the panel marks everything read and clears the badge (§7.2).
  useEffect(() => {
    markNotificationsRead();
  }, [markNotificationsRead]);

  // Overlay discipline (ui-spec §4): trap focus, restore it on close, close on
  // Escape. Mirrors ConfirmSheet rather than inventing a second convention.
  useEffect(() => {
    restoreTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("button, a, [tabindex]:not([tabindex='-1'])")?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;

      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          "button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex='-1'])"
        )
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      restoreTo.current?.focus();
    };
  }, [onClose]);

  return (
    <div
      className={styles.scrim}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Notifications"
      >
        <header className={styles.header}>
          <h2 className={styles.title}>Notifications</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close notifications">
            ✕
          </button>
        </header>

        {notices.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyHeading}>Nothing yet — you&rsquo;ll hear the moment a task finishes or fails.</p>
            {/* Worth saying plainly: an operator looking at 300 seeded rows and
                an empty inbox should not conclude notifications are broken. */}
            <p className={styles.emptyNote}>Seeded tasks produce no events and therefore no notices.</p>
          </div>
        ) : (
          <ul className={styles.list}>
            {notices.map((notice) => (
              <li key={notice.eventId}>
                <button
                  type="button"
                  className={styles.notice}
                  onClick={() => {
                    onOpenTask(notice.taskId);
                    onClose();
                  }}
                >
                  <span
                    className={styles.dot}
                    style={{
                      background: notice.read
                        ? "transparent"
                        : notice.kind === "ready"
                          ? "var(--st-ready)"
                          : "var(--st-failed)",
                    }}
                    aria-hidden="true"
                  />
                  <span className={styles.noticeBody}>
                    <span className={styles.noticeHead}>
                      <span className={styles.handle}>{notice.handle}</span>
                      <StatusChip status={notice.kind} />
                      <span className={styles.time}>{formatRelative(notice.at, now)}</span>
                    </span>
                    {/* The reason is rendered verbatim and wraps; a notice is
                        not a place to start truncating engine text. */}
                    <span
                      className={notice.kind === "failed" ? styles.detailFailed : styles.detail}
                    >
                      {notice.detail}
                      {notice.kind === "failed" && notice.retryable === false ? " — not retryable" : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <footer className={styles.footer}>
          {/* Session-scoped and capped at 50; the task timeline is the durable
              record, so clearing this loses nothing (§7.2). */}
          <span className={styles.footnote}>session-scoped · the task timeline is the durable record</span>
          {notices.length > 0 ? (
            <Button variant="secondary" onClick={clearNotifications}>
              Clear all
            </Button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
