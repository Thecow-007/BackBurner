/**
 * The task register — the SPA's main screen (frontend-brief §4.2, ui-spec §2,
 * §3.4, §3.10, §3.11, §3.13).
 *
 * A desktop grid at ≥ 900px and stacked cards below it, over one store: rows
 * mutate only when an SSE event lands, every count is the server's, and there
 * is no refresh control anywhere in this application because there is nothing
 * to refresh (frontend-brief §5).
 *
 * Three things here are load-bearing and easy to undo by accident:
 *
 *  1. Rows link by `task.id`. Handles recycle, so `/task/scrape-1` would be a
 *     link that quietly comes to mean a different task later.
 *  2. Collect is a READ THAT MUTATES — it flips `collected` and releases the
 *     handle. It fires only from a labelled press that has been confirmed;
 *     never from a render, a hover or a navigation (frontend-brief §6.1).
 *  3. The "loading more · N of M" total is `counts.matching` from the server.
 *     When counts have not landed the line drops the numbers rather than
 *     inferring a total from the pages loaded so far (ADR 0019).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";

import { Button } from "../components/Button.js";
import { ConfirmSheet } from "../components/ConfirmSheet.js";
import { EmptyState } from "../components/EmptyState.js";
import { Panel } from "../components/Panel.js";
import { SkeletonRows } from "../components/SkeletonRows.js";
import { parseSort } from "../lib/filters.js";
import { isLive } from "../lib/status.js";
import type { Counts, Task, TaskFilters, TaskStatus } from "../lib/types.js";
import {
  useActions,
  useCounts,
  useFilters,
  useListView,
  useNow,
  useVisibleTasks,
} from "../store/react.js";
import {
  clearedFilters,
  countActiveFilters,
  describeFilters,
  FilterBar,
  FilterSheet,
  StatusChipRail,
} from "./FilterSheet.js";
import { JumpTo } from "./JumpTo.js";
import { TaskCard } from "./TaskCard.js";
import { TaskRow, type RowAction } from "./TaskRow.js";
import styles from "./Register.module.css";

/** The pane counts of ui-spec §2. Kept in JS only for the two decisions CSS
 * cannot make — table vs. cards, and sheet vs. inline bar. Everything else that
 * varies by width is a media query, so there is one breakpoint per rule. */
type Panes = 1 | 2 | 3;

const CARDS = "(max-width: 899.98px)";
const THREE_PANES = "(min-width: 1280px)";

function readPanes(): Panes {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return 3;
  if (window.matchMedia(CARDS).matches) return 1;
  return window.matchMedia(THREE_PANES).matches ? 3 : 2;
}

function usePaneCount(): Panes {
  const [panes, setPanes] = useState<Panes>(readPanes);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const queries = [window.matchMedia(CARDS), window.matchMedia(THREE_PANES)];
    const onChange = (): void => setPanes(readPanes());
    for (const query of queries) query.addEventListener("change", onChange);
    return () => {
      for (const query of queries) query.removeEventListener("change", onChange);
    };
  }, []);
  return panes;
}

// ── Confirmations (ui-spec §3.8) ────────────────────────────────────────────

interface ConfirmCopy {
  question: ReactNode;
  confirmLabel: string;
  dismissLabel: string;
  confirmVariant: "danger" | "collect" | "secondary";
}

/**
 * Every action initiated from the LIST confirms first — collect, cancel and
 * retry alike — so a thumb never fires a mutation mid-scroll (ui-spec §3.8).
 * The list is a scrolling surface at every pane count and collect is
 * irreversible, so the same guard applies to the inline desktop row actions;
 * only the detail screen, where the operator is looking at the one task, may
 * act immediately.
 *
 * The copy names the task, with the handle in mono, verbatim from §3.8.
 */
function confirmCopy(task: Task, action: RowAction): ConfirmCopy {
  const handle = <span className={styles.mono}>{task.handle}</span>;
  switch (action) {
    case "cancel":
      return {
        question: <>Cancel {handle}? A running worker will be stopped.</>,
        confirmLabel: "Cancel task",
        dismissLabel: "Keep running",
        confirmVariant: "danger",
      };
    case "retry":
      return {
        question: <>Retry {handle}? It re-queues with a fresh attempt budget.</>,
        confirmLabel: "Retry task",
        dismissLabel: "Not now",
        confirmVariant: "danger",
      };
    case "collect":
      return task.status === "failed"
        ? {
            question: (
              <>
                Collect {handle}? This archives the task, frees its handle, and makes Retry
                unavailable.
              </>
            ),
            confirmLabel: "Collect / acknowledge",
            dismissLabel: "Keep it",
            confirmVariant: "secondary",
          }
        : {
            question: <>Collect {handle}? This releases its handle for reuse.</>,
            confirmLabel: "Collect result",
            dismissLabel: "Keep it",
            confirmVariant: "collect",
          };
  }
}

// ── Group counts (ui-spec §3.10) ────────────────────────────────────────────

const LIVE_STATUSES: readonly TaskStatus[] = ["queued", "running"];
const HISTORY_STATUSES: readonly TaskStatus[] = ["ready", "failed", "cancelled"];

/**
 * The count beside `LIVE` / `HISTORY`. `counts.status.*` respects the lane and
 * date filters and ignores the status filter, so a status filter has to be
 * re-applied here by hand — otherwise the header would advertise rows the list
 * cannot contain, which is exactly the "count that does not match the list it
 * opens" ui-spec §3.10 calls a bug.
 */
function groupCount(
  counts: Counts | null,
  filters: TaskFilters,
  members: readonly TaskStatus[]
): number | null {
  if (counts === null) return null;
  let total = 0;
  for (const status of members) {
    if (filters.status !== undefined && filters.status !== status) continue;
    total += counts.status[status];
  }
  return total;
}

// ── The screen ──────────────────────────────────────────────────────────────

export interface RegisterProps {
  /** The id from /task/:id, for the selected-row treatment. Null on `/`. */
  selectedId: string | null;
}

export function Register({ selectedId }: RegisterProps): ReactElement {
  const tasks = useVisibleTasks();
  const { status, error, hasMore } = useListView();
  const filters = useFilters();
  const counts = useCounts();
  const { setFilters, refresh, loadMore, cancel, retry, collect } = useActions();
  const panes = usePaneCount();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirming, setConfirming] = useState<{ task: Task; action: RowAction } | null>(null);
  // Distinguishes "loading because the filters changed" from "loading because
  // the stream went stale and the store is resyncing". Only the former earns
  // skeletons; a resync must leave the last known rows on screen
  // (frontend-brief §4.2, degraded-live).
  const [refiltering, setRefiltering] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLButtonElement>(null);
  const pageInFlight = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const hasLive = tasks.some(isLive);
  // A clock, not a request: it re-renders durations the client can already
  // compute from timestamps it holds (frontend-brief §5 rule 4).
  const now = useNow(true, hasLive ? 1000 : 30_000);

  const activeFilters = countActiveFilters(filters);
  const sort = parseSort(filters.sort);
  const sortsByCreated = sort.field === "created_at";

  const applyFilters = useCallback(
    (next: TaskFilters) => {
      setRefiltering(true);
      void setFilters(next);
    },
    [setFilters]
  );

  useEffect(() => {
    if (status !== "loading") setRefiltering(false);
  }, [status]);

  // ── Infinite scroll (ADR 0019) ────────────────────────────────────────────

  const loadNextPage = useCallback(async (): Promise<void> => {
    // Exactly one page request at a time, and only while `next_cursor` is
    // non-null. It never re-reads a page it already holds, so it cannot become
    // a polling loop by another name.
    if (pageInFlight.current || !hasMore) return;
    pageInFlight.current = true;
    setLoadingMore(true);
    try {
      await loadMore();
    } finally {
      pageInFlight.current = false;
      setLoadingMore(false);
    }
  }, [hasMore, loadMore]);

  useEffect(() => {
    const element = sentinelRef.current;
    if (!element || !hasMore) return;
    if (typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadNextPage();
      },
      { root: scrollRef.current, rootMargin: "200px" }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, loadNextPage]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const onAction = useCallback((task: Task, action: RowAction) => {
    setConfirming({ task, action });
  }, []);

  const runConfirmed = useCallback(() => {
    if (!confirming) return;
    const { task, action } = confirming;
    setConfirming(null);
    // Fire-and-forget on purpose: the control is already PENDING and stays
    // pending until the confirming SSE event lands, not until this promise
    // settles (frontend-brief §6.4). Failures surface via `actionError`.
    if (action === "cancel") void cancel(task.id);
    else if (action === "retry") void retry(task.id);
    else void collect(task.id);
  }, [confirming, cancel, retry, collect]);

  // ── List body ─────────────────────────────────────────────────────────────

  const liveTasks = useMemo(() => tasks.filter(isLive), [tasks]);
  const historyTasks = useMemo(() => tasks.filter((task) => !isLive(task)), [tasks]);

  const loaded = tasks.length;
  const matching = counts?.matching ?? null;
  const showSkeleton = status === "loading" && (refiltering || loaded === 0);

  const sentinel = hasMore ? (
    /*
     * ADR 0019: a sentinel, not a "Load more" button. It is focusable and it
     * announces what is left, so the list is not mouse-wheel-only — reaching it
     * with Tab loads the next page exactly as scrolling to it does. The design
     * page does not draw this, and that is deliberate.
     */
    <button
      type="button"
      ref={sentinelRef}
      className={styles.sentinel}
      onFocus={() => void loadNextPage()}
      onClick={() => void loadNextPage()}
      aria-label={
        matching !== null
          ? `${loaded} of ${matching} tasks loaded. Continue to load older tasks.`
          : `${loaded} tasks loaded. Continue to load older tasks.`
      }
    >
      {loadingMore ? <span className={styles.ring} aria-hidden="true" /> : null}
      <span aria-hidden="true">
        {loadingMore
          ? matching !== null
            ? `loading more · ${loaded} of ${matching}`
            : "loading more"
          : matching !== null
            ? `${loaded} of ${matching} loaded`
            : `${loaded} loaded`}
      </span>
    </button>
  ) : null;

  function renderBody(): ReactNode {
    if (status === "error") {
      return (
        <Panel tone="error" label="Snapshot failed" className={styles.errorPanel}>
          {/* The envelope's own message, verbatim and in mono. Never a blank
           * pane and never a paraphrase (ui-spec §3.11). */}
          <p className={styles.errorText}>{error ?? "The snapshot request failed."}</p>
          <div className={styles.errorActions}>
            <Button onClick={() => void refresh()}>Retry</Button>
          </div>
        </Panel>
      );
    }

    if (showSkeleton) {
      return <SkeletonRows rows={panes === 1 ? 6 : 12} bars={panes === 1 ? 1 : 3} />;
    }

    if (loaded === 0) {
      return activeFilters > 0 ? (
        <EmptyState
          heading="No tasks match these filters"
          body={<span className={styles.mono}>{describeFilters(filters, counts)}</span>}
          action={
            <Button onClick={() => applyFilters(clearedFilters(filters))}>Clear filters</Button>
          }
        />
      ) : (
        <EmptyState
          heading="No tasks yet"
          body="Submit one and you will get a handle back immediately."
          action={
            // Navigation is a link, never a button (ui-spec §4).
            <Link className={styles.primaryLink} to="/submit">
              Submit your first task
            </Link>
          }
        />
      );
    }

    if (panes === 1) {
      const liveCount = groupCount(counts, filters, LIVE_STATUSES);
      const historyCount = groupCount(counts, filters, HISTORY_STATUSES);
      return (
        <>
          {liveTasks.length > 0 ? (
            <section className={styles.group}>
              <div className={styles.groupHead}>
                <h2 className={styles.groupLabelLive}>
                  LIVE{liveCount !== null ? ` · ${liveCount}` : ""}
                </h2>
                <span className={styles.groupMeta}>updates as they happen</span>
              </div>
              <ul className={styles.cards}>
                {liveTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    selected={task.id === selectedId}
                    now={now}
                    onAction={onAction}
                  />
                ))}
              </ul>
            </section>
          ) : null}

          {historyTasks.length > 0 ? (
            <section className={styles.group}>
              <div className={styles.groupHead}>
                <h2 className={styles.groupLabel}>
                  HISTORY{historyCount !== null ? ` · ${historyCount}` : ""}
                </h2>
                <span className={styles.groupMeta}>
                  {sort.field === "created_at" ? "created" : "updated"}{" "}
                  {sort.dir === "desc" ? "↓" : "↑"}
                </span>
              </div>
              <ul className={styles.cards}>
                {historyTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    selected={task.id === selectedId}
                    now={now}
                    onAction={onAction}
                  />
                ))}
              </ul>
            </section>
          ) : null}

          {sentinel}
        </>
      );
    }

    return (
      <>
        <ul className={styles.rows}>
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              selected={task.id === selectedId}
              now={now}
              onAction={onAction}
            />
          ))}
        </ul>
        {sentinel}
      </>
    );
  }

  const confirm = confirming ? confirmCopy(confirming.task, confirming.action) : null;

  return (
    <section className={styles.register} aria-label="Task register">
      <div className={styles.toolbar}>
        <JumpTo />

        {panes === 1 ? (
          <button
            type="button"
            className={styles.filtersButton}
            onClick={() => setSheetOpen(true)}
            aria-expanded={sheetOpen}
          >
            Filters
            {activeFilters > 0 ? <span className={styles.filtersBadge}>{activeFilters}</span> : null}
          </button>
        ) : null}

        {/* Sourced straight from the server's counts; rendered only once they
         * exist, because a placeholder number would be a claim. */}
        {panes > 1 && counts !== null ? (
          <p className={styles.summary}>
            <span className={styles.running}>{counts.status.running} running</span>
            <span className={styles.summaryDot} aria-hidden="true">
              ·
            </span>
            <span className={styles.collectable}>{counts.uncollected} to collect</span>
          </p>
        ) : null}

        {/* The design's primary action sits at the top-right of the register.
            It is a link, not a button: it navigates rather than mutating. */}
        <Link className={styles.newTask} to="/submit">
          New task
        </Link>
      </div>

      {/* At one pane the shell already renders the status chip rail above the
          list (ui-spec §3.10); a second one here would be the same control
          twice. Only the date/sort row is ours at wider widths. */}
      {panes > 1 ? (
        <FilterBar filters={filters} counts={counts} onChange={applyFilters} />
      ) : null}

      {/* The desktop column header. It shares `--register-tracks` with every
       * row, which is the only way "header and rows share identical tracks and
       * gap" (ui-spec §2) cannot drift. */}
      {panes > 1 ? (
        <div className={styles.head}>
          <span />
          <span>HANDLE</span>
          <span>STATUS</span>
          <span>LANE</span>
          <span className={styles.headRight}>ATTEMPTS</span>
          <span className={styles.headSortCell}>
            {/* Not a real <table>, so aria-sort would be meaningless here; the
             * button states the ordering in its own accessible name instead. */}
            <button
              type="button"
              className={[styles.headSort, sortsByCreated ? styles.headSortOn : null]
                .filter(Boolean)
                .join(" ")}
              aria-label={
                sortsByCreated
                  ? `Sorted by created, ${sort.dir === "desc" ? "newest first" : "oldest first"}. Reverse the order.`
                  : "Sort by created."
              }
              onClick={() =>
                applyFilters({
                  ...filters,
                  sort: sortsByCreated
                    ? `created_at:${sort.dir === "desc" ? "asc" : "desc"}`
                    : `created_at:${sort.dir}`,
                })
              }
            >
              <span aria-hidden="true">
                CREATED {sortsByCreated ? (sort.dir === "desc" ? "↓" : "↑") : ""}
              </span>
            </button>
          </span>
          <span>NOTE</span>
        </div>
      ) : null}

      <div className={styles.scroll} ref={scrollRef}>
        {renderBody()}

        {/* A page request that failed leaves the list intact and says so, right
         * where the next page would have appeared. */}
        {status !== "error" && error !== null && loaded > 0 ? (
          <Panel tone="error" label="Could not load more" className={styles.errorPanel}>
            <p className={styles.errorText}>{error}</p>
            <div className={styles.errorActions}>
              <Button onClick={() => void refresh()}>Retry</Button>
            </div>
          </Panel>
        ) : null}
      </div>

      <FilterSheet
        open={sheetOpen}
        filters={filters}
        counts={counts}
        onChange={applyFilters}
        onClose={() => setSheetOpen(false)}
      />

      {confirm !== null ? (
        <ConfirmSheet
          open
          question={confirm.question}
          confirmLabel={confirm.confirmLabel}
          dismissLabel={confirm.dismissLabel}
          confirmVariant={confirm.confirmVariant}
          onConfirm={runConfirmed}
          onDismiss={() => setConfirming(null)}
        />
      ) : null}
    </section>
  );
}
