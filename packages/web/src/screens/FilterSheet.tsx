/**
 * The register's filter controls — the mobile bottom sheet, the mobile status
 * chip rail, and the compact desktop row (frontend-brief §4.2, ui-spec §3.10,
 * §7).
 *
 * Every control maps 1:1 to a `GET /tasks` query parameter: `status`, `lane`,
 * `from`, `to`, `sort`. Nothing is filtered client-side here — a change hands a
 * complete `TaskFilters` back to the register, which calls `setFilters()` and
 * takes a fresh server snapshot (frontend-brief §4.2).
 *
 * The date range and the created ↔ updated switch are the two controls the
 * approved design does not draw; ui-spec §7 records why they exist. They are
 * built in the established idiom — mono micro-labels, `--bg-raised` inputs,
 * `--line-strong` active borders — and introduce no new visual language.
 *
 * Every count shown beside a control comes from the server's `counts` object
 * (ADR 0018) and respects every active filter EXCEPT the one it represents, so
 * a count always matches the list it opens (ui-spec §3.10). When counts have
 * not landed the control renders without a number rather than with a guess.
 */
import { useEffect, useRef, type CSSProperties, type ReactElement } from "react";

import { Button } from "../components/Button.js";
import { parseSort, type SortField } from "../lib/filters.js";
import { statusPresentation, STATUS_ORDER } from "../lib/status.js";
import type { Counts, TaskFilters, TaskStatus } from "../lib/types.js";
import styles from "./FilterSheet.module.css";

// ── Pure filter helpers ─────────────────────────────────────────────────────

/** How many FILTERS are active. Sort is an ordering, not a filter, so it never
 * lights up the badge or the `Clear filters` affordance. */
export function countActiveFilters(filters: TaskFilters): number {
  let active = 0;
  if (filters.status !== undefined) active += 1;
  if (filters.lane !== undefined) active += 1;
  if (filters.from !== undefined) active += 1;
  if (filters.to !== undefined) active += 1;
  return active;
}

/**
 * The mono echo under "No tasks match these filters" (ui-spec §3.11). It states
 * the filters back verbatim so the operator can see WHICH mistake to undo —
 * that is the whole difference between this state and an empty register.
 */
export function describeFilters(filters: TaskFilters, counts: Counts | null): string {
  const parts: string[] = [];
  if (filters.status !== undefined) parts.push(`status: ${filters.status}`);
  if (filters.lane !== undefined) parts.push(`lane: ${filters.lane}`);
  if (filters.from !== undefined) parts.push(`from: ${filters.from}`);
  if (filters.to !== undefined) parts.push(`to: ${filters.to}`);
  // `all` respects from/to and ignores status/lane — it is "how many tasks are
  // in the register at all", which is exactly the contrast this state needs.
  if (counts !== null) parts.push(`${counts.all} total`);
  return parts.join(" · ");
}

/** Drop every filter, keep the ordering — clearing filters is not a re-sort. */
export function clearedFilters(filters: TaskFilters): TaskFilters {
  return filters.sort !== undefined ? { sort: filters.sort } : {};
}

function withStatus(filters: TaskFilters, status: TaskStatus | null): TaskFilters {
  const next: TaskFilters = { ...filters };
  if (status === null) delete next.status;
  else next.status = status;
  return next;
}

function withLane(filters: TaskFilters, lane: string | null): TaskFilters {
  const next: TaskFilters = { ...filters };
  if (lane === null || lane === "") delete next.lane;
  else next.lane = lane;
  return next;
}

function withDate(filters: TaskFilters, key: "from" | "to", value: string): TaskFilters {
  const next: TaskFilters = { ...filters };
  // A date-only value is exactly what the contract accepts: `from` is read as
  // 00:00:00.000Z inclusive, `to` as exclusive (api-contract §7).
  if (value === "") delete next[key];
  else next[key] = value;
  return next;
}

/** Clicking the active field flips direction; clicking the other switches field
 * and keeps the direction the operator already chose. */
function withSortField(filters: TaskFilters, field: SortField): TaskFilters {
  const current = parseSort(filters.sort);
  const dir = current.field === field ? (current.dir === "desc" ? "asc" : "desc") : current.dir;
  return { ...filters, sort: `${field}:${dir}` };
}

/** Sum of the server's own per-status numbers — the count for "all statuses"
 * under the active lane/date filters. Arithmetic over sourced values, never an
 * inference from the loaded page. */
function totalAcrossStatuses(counts: Counts): number {
  let total = 0;
  for (const status of STATUS_ORDER) total += counts.status[status];
  return total;
}

function totalAcrossLanes(counts: Counts): number {
  let total = 0;
  for (const value of Object.values(counts.lane)) total += value;
  return total;
}

// ── Shared control props ────────────────────────────────────────────────────

export interface FilterControlProps {
  filters: TaskFilters;
  /** `null` until the first snapshot lands — render no number, never a guess. */
  counts: Counts | null;
  /** Hands back a COMPLETE filter object; the register calls `setFilters`. */
  onChange(next: TaskFilters): void;
}

// ── Status chips ────────────────────────────────────────────────────────────

interface StatusChipsProps extends FilterControlProps {
  /** `compact` is the desktop bar and the mobile rail; `touch` is the sheet,
   * where every target clears 44px (ui-spec §4). */
  size: "compact" | "touch";
}

function StatusChips({ filters, counts, onChange, size }: StatusChipsProps): ReactElement {
  const active = filters.status ?? null;
  const sizeClass = size === "compact" ? styles.chipCompact : styles.chipTouch;

  return (
    <>
      <button
        type="button"
        className={[styles.filterChip, sizeClass, active === null ? styles.chipOn : null]
          .filter(Boolean)
          .join(" ")}
        aria-pressed={active === null}
        onClick={() => onChange(withStatus(filters, null))}
      >
        all
        {counts !== null ? (
          <span className={styles.chipCount}>{totalAcrossStatuses(counts)}</span>
        ) : null}
      </button>

      {STATUS_ORDER.map((status) => {
        const presentation = statusPresentation(status);
        // The ink is a token REFERENCE from lib/status.ts, never a composed
        // colour — the chip owns its geometry and nothing else.
        const ink = { "--filter-chip-ink": presentation.color } as CSSProperties;
        return (
          <button
            key={status}
            type="button"
            style={ink}
            className={[styles.filterChip, sizeClass, active === status ? styles.chipOn : null]
              .filter(Boolean)
              .join(" ")}
            aria-pressed={active === status}
            onClick={() => onChange(withStatus(filters, active === status ? null : status))}
          >
            <span className={styles.chipGlyph} aria-hidden="true">
              {presentation.glyph}
            </span>
            {presentation.label}
            {counts !== null ? (
              <span className={styles.chipCount}>{counts.status[status]}</span>
            ) : null}
          </button>
        );
      })}
    </>
  );
}

/**
 * At one pane the status counts survive as a horizontally scrolling chip rail
 * above the list, with a right-edge fade so it reads as scrollable
 * (ui-spec §3.10). It is the mobile status filter as well as the count display
 * — which is why the mobile drawer omits status counts entirely (§3.14).
 */
export function StatusChipRail(props: FilterControlProps): ReactElement {
  return (
    <div className={styles.rail}>
      <div className={styles.railScroll} role="group" aria-label="Filter by status">
        <StatusChips {...props} size="compact" />
      </div>
      <span className={styles.railFade} aria-hidden="true" />
    </div>
  );
}

// ── Lane / date / sort controls, shared by both layouts ─────────────────────

function LaneSelect({ filters, counts, onChange }: FilterControlProps): ReactElement {
  // `counts.lanes` is the engine's REGISTERED lanes, not a DISTINCT over the
  // user's data, so a key with zero tasks still gets a working picker.
  const lanes = counts?.lanes ?? [];
  return (
    <select
      className={styles.select}
      value={filters.lane ?? ""}
      onChange={(event) => onChange(withLane(filters, event.target.value))}
    >
      <option value="">
        {counts !== null ? `all lanes · ${totalAcrossLanes(counts)}` : "all lanes"}
      </option>
      {lanes.map((lane) => {
        const count = counts?.lane[lane];
        return (
          <option key={lane} value={lane}>
            {count === undefined ? lane : `${lane} · ${count}`}
          </option>
        );
      })}
    </select>
  );
}

function DateRange({ filters, onChange }: FilterControlProps): ReactElement {
  function field(key: "from" | "to"): ReactElement {
    const value = filters[key]?.slice(0, 10) ?? "";
    return (
      <label className={styles.dateField}>
        <span className={styles.dateLabel}>{key}</span>
        <input
          type="date"
          className={[styles.dateInput, value !== "" ? styles.dateOn : null]
            .filter(Boolean)
            .join(" ")}
          value={value}
          onChange={(event) => onChange(withDate(filters, key, event.target.value))}
        />
      </label>
    );
  }

  return (
    <div className={styles.range}>
      {field("from")}
      <span className={styles.rangeDash} aria-hidden="true">
        –
      </span>
      {field("to")}
    </div>
  );
}

function SortSwitch({ filters, onChange }: FilterControlProps): ReactElement {
  const sort = parseSort(filters.sort);
  const arrow = sort.dir === "desc" ? "↓" : "↑";

  return (
    <div className={styles.sort} role="group" aria-label="Sort">
      {(["created_at", "updated_at"] as const).map((field) => {
        const on = sort.field === field;
        return (
          <button
            key={field}
            type="button"
            className={[styles.sortButton, on ? styles.sortOn : null].filter(Boolean).join(" ")}
            aria-pressed={on}
            onClick={() => onChange(withSortField(filters, field))}
          >
            {field === "created_at" ? "created" : "updated"} {on ? arrow : ""}
          </button>
        );
      })}
    </div>
  );
}

// ── Desktop: the compact row above the table ────────────────────────────────

export function FilterBar(props: FilterControlProps): ReactElement {
  const { filters, onChange } = props;
  const active = countActiveFilters(filters);

  // Status and lane are NOT repeated here: at two panes and up the sidebar
  // carries both, with their counts, and the design gives the register no
  // filter bar at all. This row exists only for the two controls the sidebar
  // has no room for — the date window and the sort field (docs/ui-spec.md §7).
  return (
    <div className={styles.bar}>
      <div className={styles.group}>
        <DateRange {...props} />
      </div>
      <div className={styles.group}>
        <SortSwitch {...props} />
      </div>
      {/* Visible only when a filter is active (frontend-brief §4.2). */}
      {active > 0 ? (
        <button type="button" className={styles.clear} onClick={() => onChange(clearedFilters(filters))}>
          Clear filters
        </button>
      ) : null}
    </div>
  );
}

// ── Mobile: the bottom sheet ────────────────────────────────────────────────

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export interface FilterSheetProps extends FilterControlProps {
  open: boolean;
  onClose(): void;
}

export function FilterSheet({
  open,
  filters,
  counts,
  onChange,
  onClose,
}: FilterSheetProps): ReactElement | null {
  const sheetRef = useRef<HTMLDivElement>(null);
  const active = countActiveFilters(filters);

  // Move focus in on open and hand it back on close. An overlay that strands
  // focus behind its own scrim is worse than no overlay (ui-spec §4).
  useEffect(() => {
    if (!open) return;
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheetRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      restore?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const sheet = sheetRef.current;
      const items = sheet ? Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const activeElement = document.activeElement;
      const outside = !sheet?.contains(activeElement);
      if (event.shiftKey && (outside || activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (outside || activeElement === last)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  const controls: FilterControlProps = { filters, counts, onChange };

  return (
    <div
      className={styles.scrim}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.sheet} ref={sheetRef} role="dialog" aria-modal="true" aria-label="Filters">
        <div className={styles.grab} aria-hidden="true" />

        <div className={styles.sheetHeader}>
          <h2 className={styles.sheetTitle}>
            Filters
            {active > 0 ? <span className={styles.sheetActive}>· {active} active</span> : null}
          </h2>
          {active > 0 ? (
            <button type="button" className={styles.clearAll} onClick={() => onChange(clearedFilters(filters))}>
              Clear all
            </button>
          ) : null}
        </div>

        <div className={styles.sheetBody}>
          <p className={styles.sectionLabel}>STATUS</p>
          <div className={styles.chipWrap} role="group" aria-label="Filter by status">
            <StatusChips {...controls} size="touch" />
          </div>

          <p className={styles.sectionLabel}>LANE</p>
          <LaneSelect {...controls} />

          <p className={styles.sectionLabel}>CREATED</p>
          <DateRange {...controls} />

          <p className={styles.sectionLabel}>SORT</p>
          <SortSwitch {...controls} />
        </div>

        {/* N is the server's `counts.matching` — the number of tasks the list
         * actually holds under these filters (ADR 0018). Filters apply as they
         * are tapped, so this button only dismisses. */}
        <Button variant="primary" size="large" className={styles.show} onClick={onClose}>
          {counts !== null ? `Show ${counts.matching} tasks` : "Show tasks"}
        </Button>
      </div>
    </div>
  );
}
