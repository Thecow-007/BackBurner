/**
 * The persistent application shell (docs/ui-spec.md §2, §3.14; frontend-brief
 * §2): sidebar, mobile header, mobile drawer, and the three/two/one-pane
 * responsive layout.
 *
 * The pane count is decided by CSS media queries alone — there is no width
 * listener in this file and none anywhere in the SPA. Both the register and
 * the detail stay mounted at every width; only their visibility changes. That
 * is what keeps the sidebar from reflowing or remounting as the viewport
 * changes, and what keeps crossing a breakpoint from refetching anything.
 *
 * The routes decide WHICH pane wins (`detailActive`, `submitActive`); the media
 * queries decide what that means at the current width.
 */
import { useCallback, useState, type ReactElement, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { ConnectionIndicator } from "../components/ConnectionIndicator.js";
import { EmptyState } from "../components/EmptyState.js";
import type { ConnectionState } from "../lib/types.js";
import { useAsOfClock, useConnection } from "../store/react.js";
import { MobileDrawer } from "./MobileDrawer.js";
import { Sidebar, Wordmark } from "./Sidebar.js";
import { StatusRail } from "./StatusRail.js";
import styles from "./AppShell.module.css";

/** The resting detail pane, verbatim from ui-spec §3.11. */
const RESTING_COPY =
  "Select a task to see its parameters, full history and the actions its status permits.";

/**
 * The clock chip is read visually as "how current is this?"; a screen reader
 * needs the state said out loud, because the colour cannot carry it.
 */
const CLOCK_PREFIX: Record<ConnectionState, string> = {
  live: "Live, as of ",
  connecting: "Not live yet. Last update ",
  reconnecting: "Not live. Last update ",
  stale: "Not live. Last update ",
};

export interface AppShellProps {
  /** Fills the main column: the register, or the submit form. */
  main: ReactNode;
  /** The detail pane's content. `null` renders the resting state at three panes. */
  detail: ReactNode | null;
  /** True when the URL is /task/:id — drives the two-pane replacement and the
   *  mobile full-screen detail. */
  detailActive: boolean;
  /** True when the URL is /submit — hides the detail pane entirely. */
  submitActive: boolean;
  /** Unread badge on the Notifications nav item. */
  unreadCount: number;
  /** Fired by the Notifications nav item and the mobile header bell. */
  onOpenNotifications(): void;
  /** Overlays the whole app (the notification centre, the toast stack). */
  overlay?: ReactNode;
}

export function AppShell({
  main,
  detail,
  detailActive,
  submitActive,
  unreadCount,
  onOpenNotifications,
  overlay,
}: AppShellProps): ReactElement {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const connection = useConnection();
  const { label } = useAsOfClock();

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // The chip rail is the sidebar's STATUS counts standing in for it at one
  // pane — it belongs above the LIST, so it retires wherever there is no list.
  const showRail = !submitActive && !detailActive;

  return (
    <div className={styles.shell} data-detail={detailActive} data-submit={submitActive}>
      <header className={styles.mobileHeader}>
        <Link to="/" className={styles.brand}>
          <Wordmark />
        </Link>
        <div className={styles.headerActions}>
          <span className={styles.clock} data-state={connection}>
            <span className={styles.clockDot} aria-hidden="true" />
            <span className="sr-only">{CLOCK_PREFIX[connection]}</span>
            {label}
          </span>
          <button
            type="button"
            className={styles.bell}
            onClick={onOpenNotifications}
            aria-label="Notifications"
          >
            <span aria-hidden="true">◍</span>
            {unreadCount > 0 ? (
              <span className={styles.badge}>
                {unreadCount}
                <span className="sr-only"> unread</span>
              </span>
            ) : null}
          </button>
          <button
            type="button"
            className={styles.menuButton}
            onClick={() => setDrawerOpen(true)}
            aria-label="Menu"
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
          >
            <span aria-hidden="true">☰</span>
          </button>
        </div>
      </header>

      {/*
        Every state that is not `live` gets the full-width bar directly under the
        header (ui-spec §3.9). `connecting` and `reconnecting` join `stale` here
        because to a reader all three mean "not live yet" — the distinction the
        bar makes is in its words, which is where it belongs.
      */}
      {connection === "live" ? null : (
        <div className={styles.connBar}>
          <ConnectionIndicator state={connection} asOf={label} variant="bar" />
        </div>
      )}

      <div className={styles.body}>
        <Sidebar
          className={styles.sidebar}
          unreadCount={unreadCount}
          onOpenNotifications={onOpenNotifications}
        />

        <main className={styles.panes}>
          <section
            className={styles.mainPane}
            aria-label={submitActive ? "Submit task" : "Task register"}
          >
            {showRail ? <StatusRail className={styles.rail} /> : null}
            <div className={styles.mainContent}>{main}</div>
          </section>

          <section className={styles.detailPane} aria-label="Task detail">
            {/* Two panes only: the affordance that undoes the replacement. */}
            <div className={styles.backBar}>
              <Link to="/" className={styles.backLink}>
                <span aria-hidden="true">←</span> Register
              </Link>
            </div>
            <div className={styles.detailContent}>
              {detail ?? <EmptyState glyph="ember-bar" heading={RESTING_COPY} />}
            </div>
          </section>
        </main>
      </div>

      {overlay}

      <MobileDrawer
        open={drawerOpen}
        onClose={closeDrawer}
        unreadCount={unreadCount}
        onOpenNotifications={onOpenNotifications}
      />
    </div>
  );
}
