/**
 * Jump-to — docs/ui-spec.md §3.13.
 *
 * THERE IS NO TEXT-SEARCH ENDPOINT. This field is an exact handle-or-id lookup
 * and it says so in its own copy. It never prefix-matches, never scans error
 * text and never ranks by relevance, because promising any of that would be
 * promising a capability the API does not have (ui-spec §0).
 *
 * Matches are resolved against the tasks the store already holds. Handles
 * recycle, so one handle can name several tasks over time: every exact match is
 * listed, the current lease-holder first, then the most recent former holder —
 * the same precedence the API uses to resolve a handle (api-contract §5).
 * Navigation is always to `/task/{id}`.
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
import { formatRelative } from "../lib/format.js";
import type { Task } from "../lib/types.js";
import { useNow, useStore } from "../store/react.js";
import styles from "./JumpTo.module.css";

/** `navigator.platform` is deprecated but it is still the only synchronous
 * signal for the modifier a user's keyboard actually carries; getting this
 * wrong prints a shortcut that does not exist on their machine. */
function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.platform);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Does this task still hold its handle? Queued and running tasks do; a finished
 * task holds it until it is collected; cancelled releases it. This is the
 * "active holder wins" half of handle resolution (api-contract §5).
 */
function holdsHandle(task: Task): boolean {
  if (task.status === "cancelled") return false;
  if (task.status === "ready" || task.status === "failed") return !task.collected;
  return true;
}

export interface JumpToProps {
  /** Lets the register's toolbar size the trigger. */
  className?: string;
}

export function JumpTo({ className }: JumpToProps): ReactElement {
  const tasksById = useStore((state) => state.tasksById);
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const hintId = useId();

  // Relative timestamps in the results only need to tick while the overlay is
  // open, and only slowly — this is a clock, not a request (frontend-brief §5).
  const now = useNow(open, 30_000);
  const mac = useMemo(isMac, []);
  const term = query.trim().toLowerCase();

  const matches = useMemo(() => {
    if (term === "") return [];
    const found: Task[] = [];
    for (const task of tasksById.values()) {
      // Exact equality on both sides, case-folded. Case folding is not prefix
      // matching: `SCRAPE-1` and `scrape-1` are the same name, nothing else.
      if (task.handle.toLowerCase() === term || task.id.toLowerCase() === term) found.push(task);
    }
    found.sort((a, b) => {
      const holdA = holdsHandle(a);
      const holdB = holdsHandle(b);
      if (holdA !== holdB) return holdA ? -1 : 1;
      return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
    });
    return found;
  }, [tasksById, term]);

  /** An id the store has not loaded is still a valid route: the detail screen
   * resolves it and owns the 404. This is a jump, not a search result. */
  const unloadedId = matches.length === 0 && UUID.test(term) ? term : null;
  const optionCount = matches.length + (unloadedId !== null ? 1 : 0);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setCursor(0);
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
      const target = matches[cursor];
      if (target) go(target.id);
      else if (unloadedId !== null) go(unloadedId);
    }
  }

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
        <span className={styles.placeholder}>jump to handle or id…</span>
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
            aria-label="Jump to a task"
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
                placeholder="jump to handle or id…"
                aria-label="Jump to a handle or task id"
                aria-describedby={hintId}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setCursor(0);
                }}
                onKeyDown={onFieldKeyDown}
              />
            </div>

            <div className={styles.results}>
              {term === "" ? (
                <p className={styles.empty}>
                  Type a full handle (<span className={styles.mono}>scrape-1</span>) or a task id.
                  This is an exact lookup — BackBurner has no text search.
                </p>
              ) : null}

              {term !== "" && optionCount === 0 ? (
                <p className={styles.empty}>
                  No loaded task has the exact handle or id{" "}
                  <span className={styles.mono}>{query.trim()}</span>. Exact matches only — this
                  field does not search error text or match prefixes.
                </p>
              ) : null}

              {matches.map((task, index) => (
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
                  className={[styles.result, cursor === 0 ? styles.resultOn : null]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => go(unloadedId)}
                >
                  <span className={styles.resultHandle}>open by id</span>
                  <span className={styles.resultMeta}>not loaded here — the detail screen resolves it</span>
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
