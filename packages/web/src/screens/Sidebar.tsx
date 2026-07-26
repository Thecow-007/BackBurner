/**
 * The persistent sidebar (docs/ui-spec.md §3.14), in the order the spec fixes:
 * wordmark → connection indicator → nav → STATUS counts → LANES counts →
 * footer identity chip + `change key`.
 *
 * Two rules govern every number on this surface:
 *  1. Counts come from `useCounts()` — the server's aggregate object — and are
 *     `null` until the first snapshot lands. When they are null every slot
 *     renders an em dash. A count derived from the loaded page would be
 *     invented state and is barred (docs/frontend-brief.md §6.5).
 *  2. A count must always match the list it opens (ui-spec §3.10). That is why
 *     the `All` status row shows the SUM of `counts.status` (which respects the
 *     lane filter) rather than `counts.all` (which does not).
 *
 * This module also owns the three pieces the mobile chrome re-uses — the mark,
 * and the two filter models — so the drawer and the chip rail can never drift
 * from the sidebar's behaviour.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import { Link, useLocation } from "react-router-dom";

import { ConnectionIndicator } from "../components/ConnectionIndicator.js";
import { maskKey } from "../lib/format.js";
import { STATUS_ORDER, statusPresentation } from "../lib/status.js";
import type { TaskStatus } from "../lib/types.js";
import {
  useActions,
  useAsOfClock,
  useAuth,
  useConnection,
  useCounts,
  useFilters,
} from "../store/react.js";
import styles from "./Sidebar.module.css";

/** The one placeholder for a number the SPA cannot source (ui-spec §0). */
const NO_COUNT = "—";

/** Beyond this many lanes the flat list becomes a dropdown (ui-spec §3.14).
 * The switch is silent: no copy explains it to the user. */
const LANE_LIST_MAX = 6;

export function formatCount(value: number | null): string {
  return value === null ? NO_COUNT : String(value);
}

// ── The mark ────────────────────────────────────────────────────────────────

export interface WordmarkProps {
  /** The drawer sets the word one step larger (design 5d); the bar never
   *  changes, and it never fills or depletes (ui-spec §6). */
  size?: "default" | "large";
}

export function Wordmark({ size = "default" }: WordmarkProps): ReactElement {
  const className =
    size === "large" ? `${styles.wordmark} ${styles.wordmarkLarge}` : styles.wordmark;
  return (
    <span className={className}>
      <span className={styles.emberBar} aria-hidden="true" />
      BackBurner
    </span>
  );
}

// ── Filter models, shared with the rail and the drawer ──────────────────────

export interface StatusFilterModel {
  active: TaskStatus | undefined;
  /** Sum of `counts.status`, or null before the first snapshot. NOT
   *  `counts.all`: `all` ignores the lane filter, and clearing the status
   *  filter leaves the lane filter in place — so `all` would not match the
   *  list this row opens (ui-spec §3.10). */
  total: number | null;
  countFor(status: TaskStatus): number | null;
  select(status: TaskStatus | undefined): void;
}

export function useStatusFilter(): StatusFilterModel {
  const counts = useCounts();
  const filters = useFilters();
  const { setFilters } = useActions();

  return useMemo(
    () => ({
      active: filters.status,
      total:
        counts === null
          ? null
          : STATUS_ORDER.reduce((sum, status) => sum + counts.status[status], 0),
      countFor: (status: TaskStatus) => (counts === null ? null : counts.status[status]),
      select: (status: TaskStatus | undefined) => {
        // Re-snapshots against the server. The list is never filtered
        // client-side: that would desynchronise it from its own counts.
        void setFilters({ ...filters, status });
      },
    }),
    [counts, filters, setFilters]
  );
}

export interface LaneFilterModel {
  /** The engine's REGISTERED lanes, so a user with zero tasks still gets a
   *  working picker (`counts.lanes`, ADR 0018). */
  lanes: string[];
  active: string | undefined;
  countFor(lane: string): number | null;
  toggle(lane: string): void;
}

/**
 * `GET /tasks` takes a SINGLE `lane` value. The design draws lanes as
 * checkboxes, which reads as multi-select; with the shipped two lanes "all
 * checked" and "none checked" both mean *no lane filter*, and exactly one
 * checked means that lane. That maps cleanly, so the control is exactly that:
 * single-select-or-all. A strict subset of more than one lane is not
 * expressible against the API and is deliberately not faked client-side.
 */
export function useLaneFilter(): LaneFilterModel {
  const counts = useCounts();
  const filters = useFilters();
  const { setFilters } = useActions();

  return useMemo(
    () => ({
      lanes: counts?.lanes ?? [],
      active: filters.lane,
      // `counts.lane` is zero-filled for every registered lane, so this only
      // yields null before the first snapshot — never a guessed zero.
      countFor: (lane: string) => counts?.lane[lane] ?? null,
      toggle: (lane: string) => {
        void setFilters({ ...filters, lane: filters.lane === lane ? undefined : lane });
      },
    }),
    [counts, filters, setFilters]
  );
}

// ── Sidebar ─────────────────────────────────────────────────────────────────

export interface SidebarProps {
  /** Unread badge on the Notifications item. */
  unreadCount: number;
  /** Notifications is an overlay, not a route (ui-spec §7) — hence a button. */
  onOpenNotifications(): void;
  /** The shell's layout hook (it hides the column below 900px). */
  className?: string;
}

export function Sidebar({
  unreadCount,
  onOpenNotifications,
  className,
}: SidebarProps): ReactElement {
  const connection = useConnection();
  const { label } = useAsOfClock();
  const counts = useCounts();
  const status = useStatusFilter();
  const lanes = useLaneFilter();
  const { apiKey } = useAuth();
  const { signOut } = useActions();
  const { pathname } = useLocation();

  const statusLabelId = useId();
  const lanesLabelId = useId();

  return (
    <aside className={[styles.sidebar, className].filter(Boolean).join(" ")}>
      <div className={styles.head}>
        <Link to="/" className={styles.brand}>
          <Wordmark />
        </Link>
        <ConnectionIndicator state={connection} asOf={label} />
      </div>

      <nav className={styles.nav} aria-label="Primary">
        <Link
          to="/"
          className={styles.navItem}
          aria-current={pathname === "/" ? "page" : undefined}
        >
          <span className={styles.navGlyph} aria-hidden="true">
            ▤
          </span>
          <span className={styles.navLabel}>Task register</span>
          {/* `matching` is what the register currently holds under the active
              filters — the list this link opens (ui-spec §3.10). */}
          <span className={styles.navMeta}>
            {counts === null ? NO_COUNT : counts.matching}
          </span>
        </Link>

        <Link
          to="/submit"
          className={styles.navItem}
          aria-current={pathname === "/submit" ? "page" : undefined}
        >
          <span className={styles.navGlyph} aria-hidden="true">
            +
          </span>
          <span className={styles.navLabel}>Submit task</span>
        </Link>

        <button type="button" className={styles.navItem} onClick={onOpenNotifications}>
          <span className={styles.navGlyph} aria-hidden="true">
            ◍
          </span>
          <span className={styles.navLabel}>Notifications</span>
          {unreadCount > 0 ? (
            <span className={styles.badge}>
              {unreadCount}
              <span className="sr-only"> unread</span>
            </span>
          ) : null}
        </button>
      </nav>

      <div className={styles.section}>
        <h2 className={styles.sectionLabel} id={statusLabelId}>
          Status
        </h2>
        <div className={styles.rows} role="group" aria-labelledby={statusLabelId}>
          <button
            type="button"
            className={styles.row}
            aria-pressed={status.active === undefined}
            onClick={() => status.select(undefined)}
          >
            {/* The All row keeps the glyph column empty rather than borrowing a
                status's glyph — it is not a status. */}
            <span className={styles.glyph} aria-hidden="true" />
            <span className={styles.rowLabel}>all</span>
            <span className={styles.count}>{formatCount(status.total)}</span>
          </button>

          {STATUS_ORDER.map((value) => {
            const presentation = statusPresentation(value);
            return (
              <button
                key={value}
                type="button"
                className={styles.row}
                aria-pressed={status.active === value}
                onClick={() => status.select(status.active === value ? undefined : value)}
              >
                <span
                  className={styles.glyph}
                  style={{ "--row-ink": presentation.color } as CSSProperties}
                  aria-hidden="true"
                >
                  {presentation.glyph}
                </span>
                <span className={styles.rowLabel}>{presentation.label}</span>
                <span className={styles.count}>{formatCount(status.countFor(value))}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionLabel} id={lanesLabelId}>
          Lanes
        </h2>
        {lanes.lanes.length > LANE_LIST_MAX ? (
          <LaneDropdown model={lanes} labelledBy={lanesLabelId} />
        ) : (
          <div className={styles.rows} role="group" aria-labelledby={lanesLabelId}>
            {lanes.lanes.map((lane) => (
              <LaneRow key={lane} lane={lane} model={lanes} />
            ))}
          </div>
        )}
      </div>

      <div className={styles.foot}>
        <span className={styles.key}>{maskKey(apiKey)}</span>
        <button type="button" className={styles.changeKey} onClick={signOut}>
          change key
        </button>
      </div>
    </aside>
  );
}

// ── Lane controls ───────────────────────────────────────────────────────────

function LaneRow({ lane, model }: { lane: string; model: LaneFilterModel }): ReactElement {
  const checked = model.active === lane;
  return (
    <button
      type="button"
      className={styles.row}
      aria-pressed={checked}
      onClick={() => model.toggle(lane)}
    >
      <span className={styles.box} data-checked={checked} aria-hidden="true">
        {checked ? "✓" : ""}
      </span>
      <span className={styles.rowLabel}>{lane}</span>
      <span className={styles.count}>{formatCount(model.countFor(lane))}</span>
    </button>
  );
}

/**
 * Beyond six lanes the flat list becomes a filterable dropdown. The rows behave
 * exactly as the flat ones do — the API's single `lane` parameter does not
 * change because the control did.
 */
function LaneDropdown({
  model,
  labelledBy,
}: {
  model: LaneFilterModel;
  labelledBy: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Node | null;
      if (target === null) return;
      if (popoverRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") close(true);
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  const needle = query.trim().toLowerCase();
  const visible = needle === "" ? model.lanes : model.lanes.filter((l) => l.toLowerCase().includes(needle));

  return (
    <div className={styles.laneMenu}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.laneTrigger}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((was) => !was)}
      >
        <span className={styles.laneTriggerLabel}>{model.active ?? "all lanes"}</span>
        <span className={styles.laneCaret} aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <div className={styles.lanePopover} ref={popoverRef}>
          <input
            className={styles.laneSearch}
            type="search"
            value={query}
            placeholder="filter lanes…"
            aria-label="Filter lanes"
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className={styles.laneList} role="group" aria-labelledby={labelledBy}>
            {visible.length === 0 ? (
              <p className={styles.laneEmpty}>no lane matches</p>
            ) : (
              visible.map((lane) => <LaneRow key={lane} lane={lane} model={model} />)
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
