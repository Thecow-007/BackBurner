/**
 * The persistent application shell (docs/ui-spec.md §2, §3.14; frontend-brief
 * §2): sidebar, mobile header, mobile drawer, and the three/two/one-pane
 * responsive layout.
 *
 * **The pane COUNT is decided by CSS media queries alone.** Nothing in this SPA
 * listens to the viewport width in order to choose a layout, and nothing may
 * start: both the register and the detail stay mounted at every width and only
 * their visibility changes, which is what keeps the sidebar from reflowing or
 * remounting as the viewport changes and what keeps crossing a breakpoint from
 * refetching anything.
 *
 * The two drag handles below are not an exception to that rule. A pointer drag
 * writes ONE number — the pane's preferred width — into a custom property, and
 * the property is consumed inside `clamp(<min>, var(--…-w), <cap>vw)`, so the
 * caps enforce themselves in CSS as the viewport changes (ADR 0025). The
 * viewport is measured only at the moment of an interaction, and only to keep
 * `aria-valuemax` and the drag's own feel honest; no layout decision reads it,
 * and there is no resize listener.
 *
 * The routes decide WHICH pane wins (`detailActive`, `submitActive`); the media
 * queries decide what that means at the current width. With nothing selected the
 * detail pane does not render at all and the register takes the whole row
 * (ADR 0026).
 */
import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";

import { ConnectionIndicator } from "../components/ConnectionIndicator.js";
import { clearPaneWidth, getPaneWidth, setPaneWidth, type PaneId } from "../lib/storage.js";
import type { ConnectionState } from "../lib/types.js";
import { useAsOfClock, useConnection } from "../store/react.js";
import { MobileDrawer } from "./MobileDrawer.js";
import { Sidebar, Wordmark } from "./Sidebar.js";
import { StatusRail } from "./StatusRail.js";
import styles from "./AppShell.module.css";

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

// ── Pane resizing (ADR 0025) ────────────────────────────────────────────────
//
// The limits the repo owner set. The minimums are what the pane must hold: the
// sidebar carries the wordmark, the counts and the identity chip; the detail
// pane carries the duration readout and the timeline. The caps are viewport
// fractions and live in CSS, inside the same `clamp()` that consumes the stored
// width — so a width dragged on a 2560px monitor cannot swallow a 1280px one.

const SIDEBAR_MIN = 200;
const SIDEBAR_CAP_RATIO = 0.3;
const SIDEBAR_DEFAULT = 230; // matches --sidebar-w in theme/tokens.css

const DETAIL_MIN = 360;
const DETAIL_CAP_RATIO = 0.5;
const DETAIL_DEFAULT = 446; // matches --detail-w in theme/tokens.css

/** One arrow press. Coarse enough to move visibly, fine enough to land on a
 * chosen width in a few presses. */
const KEY_STEP = 16;

/** The viewport fraction the cap works out to right now. Read only during an
 * interaction — never to decide a layout. CSS re-clamps on every frame anyway,
 * so a stale reading can affect nothing but this handle's own ARIA value until
 * the next press. */
function measureCap(ratio: number): number {
  if (typeof window === "undefined") return Number.POSITIVE_INFINITY;
  return Math.round(window.innerWidth * ratio);
}

interface ResizeHandleProps {
  pane: PaneId;
  /** Accessible name — a bare "separator" tells a screen-reader user nothing. */
  label: string;
  min: number;
  capRatio: number;
  /** The token's value, used when nothing has been dragged yet. */
  defaultWidth: number;
  /** +1 when dragging right GROWS the pane (sidebar), −1 when it shrinks it
   *  (the detail pane, whose handle is on its left edge). */
  direction: 1 | -1;
  /** The dragged width, or null while the token default is in force. */
  width: number | null;
  onPreview(width: number): void;
  onCommit(width: number | null): void;
  className?: string;
}

/**
 * A real control, not a decorative strip: `role="separator"` with the full value
 * set, reachable by Tab, resizable with the arrow keys, Home/End to the limits,
 * double-click to reset. Pointer events rather than mouse events, so a trackpad
 * and a touchscreen both work.
 *
 * The visible hairline stays one pixel wide; the hit area is widened by a
 * transparent pseudo-element, so the target is comfortable without the rule
 * becoming a bar (ui-spec §2).
 */
function ResizeHandle({
  pane,
  label,
  min,
  capRatio,
  defaultWidth,
  direction,
  width,
  onPreview,
  onCommit,
  className,
}: ResizeHandleProps): ReactElement {
  const current = width ?? defaultWidth;
  const [cap, setCap] = useState(() => measureCap(capRatio));
  const ref = useRef<HTMLDivElement>(null);

  /**
   * The width this handle is *working from*, which is not always the width it
   * last rendered. Key auto-repeat fires many `keydown`s inside one React
   * batch, so four ArrowRights all reading the rendered `current` would each
   * compute `current + 16` and the pane would move one step instead of four.
   * This ref accumulates within a burst and re-syncs whenever a render actually
   * lands — the standard derive-during-render reset, not an effect.
   */
  const working = useRef(current);
  const rendered = useRef(current);
  if (rendered.current !== current) {
    rendered.current = current;
    working.current = current;
  }
  // `latest` tracks what the drag has previewed so far. The commit reads it
  // rather than the rendered `current`, because a pointerup can arrive before
  // React has re-rendered the last move — and committing the value from a stale
  // render would persist a width the user never let go of.
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    cap: number;
    latest: number;
  } | null>(null);

  const clamp = (value: number, capNow: number): number =>
    Math.round(Math.min(Math.max(value, min), Math.max(min, capNow)));

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const capNow = measureCap(capRatio);
    setCap(capNow);
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: working.current,
      cap: capNow,
      latest: working.current,
    };
    ref.current?.setPointerCapture(event.pointerId);
    // Stops the drag from selecting the text either side of the rule.
    event.preventDefault();
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const state = drag.current;
    if (state === null || state.pointerId !== event.pointerId) return;
    state.latest = clamp(state.startWidth + (event.clientX - state.startX) * direction, state.cap);
    working.current = state.latest;
    onPreview(state.latest);
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    const state = drag.current;
    if (state === null || state.pointerId !== event.pointerId) return;
    drag.current = null;
    ref.current?.releasePointerCapture(event.pointerId);
    // One localStorage write per drag, not one per frame.
    onCommit(state.latest);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const capNow = measureCap(capRatio);
    const from = working.current;
    let next: number;
    if (event.key === "ArrowRight") next = clamp(from + KEY_STEP * direction, capNow);
    else if (event.key === "ArrowLeft") next = clamp(from - KEY_STEP * direction, capNow);
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = Math.max(min, capNow);
    else return;
    event.preventDefault();
    working.current = next;
    setCap(capNow);
    onCommit(next);
  }

  return (
    <div
      ref={ref}
      className={[styles.handle, className].filter(Boolean).join(" ")}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={current}
      aria-valuemin={min}
      aria-valuemax={Number.isFinite(cap) ? Math.max(min, cap) : undefined}
      tabIndex={0}
      data-pane={pane}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        working.current = defaultWidth;
        onCommit(null);
      }}
    />
  );
}

export interface AppShellProps {
  /** Fills the main column: the register, or the submit form. */
  main: ReactNode;
  /** The detail pane's content. `null` means nothing is selected, and at every
   *  pane count the pane is then not shown at all (ADR 0026). */
  detail: ReactNode | null;
  /** True when the URL is /task/:id — drives the two-pane replacement, the
   *  three-pane pane, and the mobile full-screen detail. */
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

  // The dragged widths. `null` means "no choice made" and the token default
  // applies — which is also what a double-click restores, rather than writing
  // the default in as though it had been chosen.
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(
    () => getPaneWidth("sidebar") ?? null
  );
  const [detailWidth, setDetailWidth] = useState<number | null>(() => getPaneWidth("detail") ?? null);

  const commitWidth = useCallback((pane: PaneId, value: number | null) => {
    const apply = pane === "sidebar" ? setSidebarWidth : setDetailWidth;
    apply(value);
    if (value === null) clearPaneWidth(pane);
    else setPaneWidth(pane, value);
  }, []);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // The chip rail is the sidebar's STATUS counts standing in for it at one
  // pane — it belongs above the LIST, so it retires wherever there is no list.
  const showRail = !submitActive && !detailActive;

  // Only these two properties are written from JS. The clamps that bound them
  // live in the stylesheet, so the caps hold as the viewport changes without a
  // listener and without clamping logic here.
  const shellVars: Record<string, string> = {};
  if (sidebarWidth !== null) shellVars["--sidebar-w"] = `${sidebarWidth}px`;
  if (detailWidth !== null) shellVars["--detail-w"] = `${detailWidth}px`;
  const shellStyle = shellVars as CSSProperties;

  return (
    <div
      className={styles.shell}
      style={shellStyle}
      data-detail={detailActive}
      data-submit={submitActive}
    >
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

        {/* Draws the hairline between the sidebar and the register, and moves
            it. Hidden below 900px, where the sidebar is a drawer. */}
        <ResizeHandle
          pane="sidebar"
          label="Resize the sidebar"
          min={SIDEBAR_MIN}
          capRatio={SIDEBAR_CAP_RATIO}
          defaultWidth={SIDEBAR_DEFAULT}
          direction={1}
          width={sidebarWidth}
          onPreview={setSidebarWidth}
          onCommit={(value) => commitWidth("sidebar", value)}
          className={styles.sidebarHandle}
        />

        <main className={styles.panes}>
          <section
            className={styles.mainPane}
            aria-label={submitActive ? "Submit task" : "Task register"}
          >
            {showRail ? <StatusRail className={styles.rail} /> : null}
            <div className={styles.mainContent}>{main}</div>
          </section>

          {/* Draws the hairline on the detail pane's left edge, and moves it.
              Shown only at three panes, and only with a task selected. */}
          <ResizeHandle
            pane="detail"
            label="Resize the task detail pane"
            min={DETAIL_MIN}
            capRatio={DETAIL_CAP_RATIO}
            defaultWidth={DETAIL_DEFAULT}
            direction={-1}
            width={detailWidth}
            onPreview={setDetailWidth}
            onCommit={(value) => commitWidth("detail", value)}
            className={styles.detailHandle}
          />

          <section className={styles.detailPane} aria-label="Task detail">
            {/* Two panes only: the affordance that undoes the replacement. */}
            <div className={styles.backBar}>
              <Link to="/" className={styles.backLink}>
                <span aria-hidden="true">←</span> Register
              </Link>
            </div>
            {/*
              No resting empty state. With nothing selected this pane is not
              shown and the register spans the full row, so the state that copy
              described is unreachable (ADR 0026, ui-spec §3.11).
            */}
            <div className={styles.detailContent}>{detail}</div>
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
