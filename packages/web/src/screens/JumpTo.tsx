/**
 * Search — docs/ui-spec.md §3.13, ADR 0027.
 *
 * This field is a REAL partial search, because the API has one: `GET /tasks?q=`
 * matches handle and id by equality **or prefix**, case-insensitively
 * (api-contract §7). `q=scrape` lists every scrape; `q=scrape-1` lists
 * `scrape-1`, `scrape-10`, `scrape-19`… It is still a jump-to as well — paste an
 * id and open it.
 *
 * Two rules shape this file:
 *
 *  1. **The server ranks; this file does not re-rank.** The response is already
 *     ordered: exact handle-or-id matches first, then tasks that still hold
 *     their handle (queued/running, or ready/failed uncollected) ahead of
 *     released former holders, then `created_at` descending. Sorting it again
 *     client-side would throw away the ranking the request was made for. Tier
 *     two exists because handles recycle — a live `report-1` and a released
 *     former `report-1` both answer honestly, and the live one is the one the
 *     caller meant (api-contract §5).
 *  2. **Results never enter the store.** They are held in local state for as
 *     long as the overlay is open and thrown away when it closes; merging them
 *     would splice foreign rows into the register's list order and corrupt its
 *     locally maintained counts (ADR 0027).
 *
 * Navigation is always to `/task/{id}`, never by handle: handles recycle, so a
 * link built from one would quietly come to mean a different task later.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
import { useNavigate } from "react-router-dom";

import { StatusChip } from "../components/StatusChip.js";
import { ApiError } from "../lib/api.js";
import { formatRelative } from "../lib/format.js";
import type { Task } from "../lib/types.js";
import { useActions, useNow, useStore } from "../store/react.js";
import styles from "./JumpTo.module.css";

/** `navigator.platform` is deprecated but it is still the only synchronous
 * signal for the modifier a user's keyboard actually carries; getting this
 * wrong prints a shortcut that does not exist on their machine. */
function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.platform);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Long enough that a fast typist issues one request instead of eight, short
 * enough that the list feels like it is keeping up. */
const DEBOUNCE_MS = 150;

/** api-contract §7: `q` is 1–64 characters after trimming. Anything longer is a
 * 400, so it is trimmed here rather than sent and rejected. */
const MAX_Q = 64;

/**
 * Does this task still hold its handle? Queued and running tasks do; a finished
 * task holds it until it is collected; cancelled releases it. Used only by the
 * degraded local fallback below — the server applies this same rule as tier two
 * of its own ranking (api-contract §5, §7).
 */
function holdsHandle(task: Task): boolean {
  if (task.status === "cancelled") return false;
  if (task.status === "ready" || task.status === "failed") return !task.collected;
  return true;
}

type Mode = "idle" | "loading" | "server" | "degraded";

export interface JumpToProps {
  /** Lets the register's toolbar size the trigger. */
  className?: string;
}

export function JumpTo({ className }: JumpToProps): ReactElement {
  const tasksById = useStore((state) => state.tasksById);
  const { search } = useActions();
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  // The answer to ONE search. Local state, never the store (ADR 0027).
  const [results, setResults] = useState<Task[]>([]);
  const [matching, setMatching] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>("idle");

  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const hintId = useId();

  // Relative timestamps in the results only need to tick while the overlay is
  // open, and only slowly — this is a clock, not a request (frontend-brief §5).
  const now = useNow(open, 30_000);
  const mac = useMemo(isMac, []);
  const term = query.trim().slice(0, MAX_Q);

  /** The degraded answer: an exact scan of the tasks the store happens to hold.
   * Used only when the request itself failed, and always labelled as limited. */
  const localMatches = useCallback(
    (needle: string): Task[] => {
      const folded = needle.toLowerCase();
      const found: Task[] = [];
      for (const task of tasksById.values()) {
        if (task.handle.toLowerCase() === folded || task.id.toLowerCase() === folded) {
          found.push(task);
        }
      }
      found.sort((a, b) => {
        const holdA = holdsHandle(a);
        const holdB = holdsHandle(b);
        if (holdA !== holdB) return holdA ? -1 : 1;
        return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
      });
      return found;
    },
    [tasksById]
  );

  // ── The search read (the fifth read moment, frontend-brief §5 rule 4) ──────
  //
  // Debounced, and the in-flight request is ABORTED the moment the term moves
  // on — otherwise a slow early response could land after a fast later one and
  // paint results for a term the user has already replaced.
  useEffect(() => {
    if (!open) return;
    if (term === "") {
      setResults([]);
      setMatching(null);
      setMode("idle");
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setMode("loading");

    const timer = setTimeout(() => {
      void search(term, controller.signal)
        .then((res) => {
          if (cancelled) return;
          // Rendered in the SERVER'S order, verbatim. No client-side sort.
          setResults(res.tasks);
          setMatching(res.matching);
          setMode("server");
          setCursor(0);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          // An abort is this effect cleaning up after itself, not a failure.
          if (err instanceof ApiError && err.code === "aborted") return;
          setResults(localMatches(term));
          setMatching(null);
          setMode("degraded");
          setCursor(0);
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, term, search, localMatches]);

  /** An id the search did not return is still a valid route: the detail screen
   * resolves it and owns the 404. This is the jump half of the field. */
  const unloadedId =
    UUID.test(term) && !results.some((task) => task.id.toLowerCase() === term.toLowerCase())
      ? term
      : null;
  const optionCount = results.length + (unloadedId !== null ? 1 : 0);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setCursor(0);
    setResults([]);
    setMatching(null);
    setMode("idle");
  }, []);

  const go = useCallback(
    (id: string) => {
      close();
      triggerRef.current?.focus();
      void navigate(`/task/${id}`);
    },
    [close, navigate]
  );

  // ⌘K / Ctrl+K opens from anywhere in the app.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key.toLowerCase() !== "k") return;
      if (!(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setOpen(true);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Focus the field on open, hand focus back to the trigger on close.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  // Escape closes; Tab cycles inside (ui-spec §4).
  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const root = overlayRef.current;
      const items = root
        ? Array.from(
            root.querySelectorAll<HTMLElement>('input, button:not([disabled]), [tabindex]:not([tabindex="-1"])')
          )
        : [];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      const outside = !root?.contains(active);
      if (event.shiftKey && (outside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (outside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, close]);

  function onFieldKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((c) => (optionCount === 0 ? 0 : (c + 1) % optionCount));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((c) => (optionCount === 0 ? 0 : (c - 1 + optionCount) % optionCount));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = results[cursor];
      if (target) go(target.id);
      else if (unloadedId !== null) go(unloadedId);
    }
  }

  // `counts.matching` is the WHOLE match set under `q`, not the page — which is
  // what lets this line be honest without inferring anything (api-contract §6.2).
  const truncated = matching !== null && matching > results.length;

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={[styles.trigger, className].filter(Boolean).join(" ")}
        onClick={() => setOpen(true)}
      >
        <span className={styles.glyph} aria-hidden="true">
          ⌕
        </span>
        <span className={styles.placeholder}>search handles or paste an id…</span>
        <span className={styles.kbd} aria-hidden="true">
          {mac ? "⌘K" : "Ctrl K"}
        </span>
      </button>

      {open ? (
        <div
          className={styles.scrim}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              close();
              triggerRef.current?.focus();
            }
          }}
        >
          <div
            className={styles.overlay}
            ref={overlayRef}
            role="dialog"
            aria-modal="true"
            aria-label="Search tasks"
          >
            <div className={styles.field}>
              <span className={styles.glyph} aria-hidden="true">
                ⌕
              </span>
              <input
                ref={inputRef}
                className={styles.input}
                type="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={MAX_Q}
                placeholder="search handles or paste an id…"
                aria-label="Search handles or paste a task id"
                aria-describedby={hintId}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setCursor(0);
                }}
                onKeyDown={onFieldKeyDown}
              />
              {mode === "loading" ? (
                <span className={styles.spinner} aria-hidden="true" />
              ) : null}
            </div>

            {/* The one line that says how many of how many, and where the
                answer came from. Never a number the response did not carry. */}
            {mode === "server" && truncated ? (
              <p className={styles.status} role="status">
                showing {results.length} of {matching} matches
              </p>
            ) : null}

            {mode === "degraded" ? (
              <p className={styles.statusDegraded} role="status">
                Search is unavailable right now, so these are exact matches among the tasks
                already loaded — not the whole register.
              </p>
            ) : null}

            <div className={styles.results}>
              {term === "" ? (
                <p className={styles.empty}>
                  Search handles by prefix — <span className={styles.mono}>scrape</span> lists
                  every scrape, <span className={styles.mono}>scrape-1</span> puts{" "}
                  <span className={styles.mono}>scrape-1</span> first. Or paste a task id to
                  open it.
                </p>
              ) : null}

              {term !== "" && mode === "loading" && results.length === 0 ? (
                <p className={styles.empty}>searching…</p>
              ) : null}

              {/* Two different "nothing found"s, because they mean different
                  things: the server's answer is about the whole register, the
                  degraded one is only about the rows already loaded. */}
              {term !== "" && mode === "server" && optionCount === 0 ? (
                <p className={styles.empty}>
                  No task matches <span className={styles.mono}>{term}</span>. Matching is on
                  handle and id — by whole value or by prefix — and never on error text.
                </p>
              ) : null}

              {term !== "" && mode === "degraded" && optionCount === 0 ? (
                <p className={styles.empty}>
                  No loaded task has the exact handle or id{" "}
                  <span className={styles.mono}>{term}</span>. There may be one in the register
                  this browser has not loaded.
                </p>
              ) : null}

              {results.map((task, index) => (
                <button
                  key={task.id}
                  type="button"
                  className={[styles.result, index === cursor ? styles.resultOn : null]
                    .filter(Boolean)
                    .join(" ")}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => go(task.id)}
                >
                  <span className={styles.resultHandle}>{task.handle}</span>
                  <StatusChip status={task.status} muted={task.collected} />
                  <span className={styles.resultMeta}>
                    {task.lane} · {formatRelative(task.created_at, now)}
                  </span>
                  {/* Handles recycle, so when one names several tasks the id is
                   * the only thing that tells them apart. */}
                  <span className={styles.resultId}>{task.id}</span>
                </button>
              ))}

              {unloadedId !== null ? (
                <button
                  type="button"
                  className={[styles.result, cursor === results.length ? styles.resultOn : null]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => go(unloadedId)}
                >
                  <span className={styles.resultHandle}>open by id</span>
                  <span className={styles.resultMeta}>
                    not in these results — the detail screen resolves it
                  </span>
                  <span className={styles.resultId}>{unloadedId}</span>
                </button>
              ) : null}
            </div>

            <p className={styles.hint} id={hintId}>
              ↑↓ move · ↵ open · esc close
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}
