/**
 * The single client-side store (docs/frontend-brief.md §5) — a framework-
 * agnostic Zustand *vanilla* store so React components bind to it later with
 * `useStore(store, selector)` and non-React code (tests) can drive it directly.
 *
 * The discipline this file enforces, verbatim from §5:
 *  1. Hydrate once from a `GET /tasks` snapshot, capturing `as_of`.
 *  2. Subscribe to `/events?since=<as_of>` — gap-free, no overlap.
 *  3. The store mutates ONLY on SSE events. REST responses to actions are
 *     acknowledgements, never merged as truth; the confirming event is.
 *  4. Zero polling. Reads happen at five moments only: hydration, filter/
 *     pagination changes, detail mount, the single event-driven backfill, and
 *     the search overlay's user-driven lookup (ADR 0027). None is on a timer.
 *  5. Actions are requests, events are facts: a pressed control stays pending
 *     until its confirming event arrives (§6.4).
 *
 * Everything is correlated by immutable `task_id` (handles recycle, §5.2), and
 * events are de-duplicated by their monotonic id so post-reconnect replays are
 * harmless.
 */
import { createStore, type StoreApi } from "zustand/vanilla";

import { ApiClient, ApiError } from "../lib/api.js";
import { isUncollected, matchesFilters, parseSort, sortIds } from "../lib/filters.js";
import { SseClient } from "../lib/sse.js";
import { clearStoredKey, getStoredKey, setStoredKey } from "../lib/storage.js";
import type {
  ConnectionState,
  Counts,
  HistoryTransition,
  LifecycleEvent,
  NotificationNotice,
  PendingAction,
  SubmitInput,
  Task,
  TaskFilters,
} from "../lib/types.js";

const SNAPSHOT_LIMIT = 50;
const PENDING_TIMEOUT_MS = 10_000; // §6.4: no confirming event in 10s → resync

export type AuthStatus = "unauthenticated" | "validating" | "authenticated" | "error";
export type ListStatus = "idle" | "loading" | "live" | "error";

/**
 * One search read's answer (ADR 0027). `tasks` is the server's page IN THE
 * SERVER'S RANK ORDER — the caller renders it verbatim. `matching` is the true
 * total across all matches, so an overlay showing 20 of them can say so.
 */
export interface SearchResult {
  tasks: Task[];
  matching: number | null;
}

/** A transient error from a failed mutating action, for the UI to toast (§4.4). */
export interface ActionError {
  action: PendingAction;
  taskId: string | null;
  code: string;
  message: string;
  currentStatus?: string;
}

export interface StoreState {
  // Auth / session
  apiKey: string | null;
  authStatus: AuthStatus;
  authError: string | null;

  // Live connection (header indicator, §5.4)
  connection: ConnectionState;

  // Authoritative task data, keyed by immutable id
  tasksById: Map<string, Task>;

  // Dashboard view (server-driven page for the active filters/sort)
  filters: TaskFilters;
  listOrder: string[];
  nextCursor: string | null;
  asOf: number;
  listStatus: ListStatus;
  listError: string | null;

  /** Server-computed aggregate counts for the active filters (ADR 0018).
   * `null` until the first snapshot lands, or if the server does not send them
   * — the UI then shows a neutral placeholder and NEVER a fabricated number. */
  counts: Counts | null;

  // Per-task transition timelines (detail screen, §4.4)
  historyById: Map<string, HistoryTransition[]>;

  // Mutating actions in flight, keyed by task id (§6.4)
  pending: Map<string, Set<PendingAction>>;
  actionError: ActionError | null;

  // Completion/failure notices (§7)
  notifications: NotificationNotice[];
}

export interface StoreActions {
  /** On app boot: if a key is stored, validate + hydrate; else stay at gate. */
  bootstrap(): Promise<void>;
  /** Validate a key with a real `GET /tasks?limit=1`, then enter the app. */
  signIn(key: string): Promise<void>;
  /** Clear the key + all state and tear down the stream. */
  signOut(): void;

  /** Replace the active filters and re-snapshot (§4.2). */
  setFilters(filters: TaskFilters): Promise<void>;
  /** Re-snapshot the current filters (error-state Retry, manual refresh). */
  refresh(): Promise<void>;
  /** Follow `next_cursor` for the next page (§4.2 "Load more"). */
  loadMore(): Promise<void>;

  submit(input: SubmitInput): Promise<Task>;
  cancel(id: string): Promise<void>;
  retry(id: string): Promise<void>;
  collect(id: string): Promise<void>;

  /** Detail mount: fetch the task + its history (§4.4). Merges into the store
   * so live events keep updating it; rejects with ApiError on 404/400. */
  loadDetail(id: string): Promise<{ task: Task; history: HistoryTransition[] }>;

  /**
   * `GET /tasks?q=` for the search overlay — the fifth read moment (§5 rule 4,
   * ADR 0027). User-driven, exactly like a filter change; never on a timer.
   *
   * It deliberately writes NOTHING: not `tasksById`, not `listOrder`, not
   * `counts`, not `historyById`. Search results are a different question from
   * the register's question — merging them would splice foreign rows into the
   * register's server-given list order and corrupt the locally maintained
   * counters, whose bases are the register's filters and not the search term.
   * The overlay holds the answer in local component state and throws it away
   * when it closes.
   */
  search(term: string, signal?: AbortSignal): Promise<SearchResult>;

  markNotificationsRead(): void;
  clearNotifications(): void;
  dismissActionError(): void;
}

export type BackburnerStore = StoreState & StoreActions;

const initialState = (): StoreState => ({
  apiKey: getStoredKey(),
  authStatus: "unauthenticated",
  authError: null,
  connection: "connecting",
  tasksById: new Map(),
  filters: {},
  listOrder: [],
  nextCursor: null,
  asOf: 0,
  listStatus: "idle",
  listError: null,
  counts: null,
  historyById: new Map(),
  pending: new Map(),
  actionError: null,
  notifications: [],
});

export function createBackburnerStore(baseUrl = ""): StoreApi<BackburnerStore> {
  return createStore<BackburnerStore>((set, get) => {
    // ── non-reactive refs (not part of rendered state) ──────────────────────
    let api: ApiClient | null = null;
    let sse: SseClient | null = null;
    let maxAppliedId = 0; // event-dedupe watermark (ids are monotonic per user)
    const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

    // ── pending helpers (§6.4) ──────────────────────────────────────────────
    function pendingKey(taskId: string, action: PendingAction): string {
      return `${taskId}:${action}`;
    }

    function markPending(taskId: string, action: PendingAction): void {
      set((s) => {
        const pending = new Map(s.pending);
        const set2 = new Set(pending.get(taskId) ?? []);
        set2.add(action);
        pending.set(taskId, set2);
        return { pending };
      });
      const key = pendingKey(taskId, action);
      const existing = pendingTimers.get(key);
      if (existing) clearTimeout(existing);
      pendingTimers.set(
        key,
        setTimeout(() => {
          // REST succeeded but the confirming event never arrived — assume a
          // stale stream and force the §5.3 resync; the event will replay.
          if (get().pending.get(taskId)?.has(action)) void resync();
        }, PENDING_TIMEOUT_MS)
      );
    }

    function clearPending(taskId: string, action: PendingAction): void {
      const key = pendingKey(taskId, action);
      const timer = pendingTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        pendingTimers.delete(key);
      }
      set((s) => {
        const current = s.pending.get(taskId);
        if (!current || !current.has(action)) return {};
        const pending = new Map(s.pending);
        const set2 = new Set(current);
        set2.delete(action);
        if (set2.size === 0) pending.delete(taskId);
        else pending.set(taskId, set2);
        return { pending };
      });
    }

    // ── event application (§5.1) ────────────────────────────────────────────

    /** Apply an event's status/field change onto a prior task (or a fresh one
     * synthesized from the event when the task is unknown). Only event-owned
     * fields are touched; static fields come from the backfill/snapshot. */
    function mutateTask(prev: Task | undefined, ev: LifecycleEvent): Task {
      const base: Task =
        prev ??
        {
          handle: ev.handle,
          lane: ev.lane,
          params: {},
          status: "queued",
          result: null,
          error: null,
          created_at: ev.at,
          updated_at: ev.at,
          collected: false,
          id: ev.task_id,
          attempts: 0,
          max_attempts: 3,
          seeded: false,
        };
      const next: Task = { ...base, handle: ev.handle, lane: ev.lane, updated_at: ev.at };
      switch (ev.type) {
        case "accepted":
          next.status = "queued";
          break;
        case "running":
          next.status = "running";
          if (typeof ev.attempt === "number") next.attempts = ev.attempt;
          if (typeof ev.max_attempts === "number") next.max_attempts = ev.max_attempts;
          break;
        case "retrying":
          next.status = "queued";
          if (typeof ev.attempt === "number") next.attempts = ev.attempt;
          break;
        case "ready":
          next.status = "ready";
          break;
        case "failed":
          next.status = "failed";
          next.error = {
            reason: typeof ev.reason === "string" ? ev.reason : "failed",
            retryable: ev.retryable === true,
          };
          break;
        case "cancelled":
          next.status = "cancelled";
          break;
        case "collected":
          next.collected = true;
          break;
      }
      return next;
    }

    /** Recompute this task's membership + position in the dashboard list. */
    function reindex(listOrder: string[], task: Task, filters: TaskFilters, byId: Map<string, Task>): string[] {
      const sort = parseSort(filters.sort);
      const present = listOrder.includes(task.id);
      const belongs = matchesFilters(task, filters);
      if (belongs && !present) return sortIds([...listOrder, task.id], byId, sort);
      if (!belongs && present) return listOrder.filter((id) => id !== task.id);
      if (belongs) return sortIds(listOrder, byId, sort); // re-sort in place
      return listOrder;
    }

    function noticeFor(ev: LifecycleEvent): NotificationNotice | null {
      if (ev.type !== "ready" && ev.type !== "failed") return null;
      return {
        eventId: ev.id,
        taskId: ev.task_id,
        handle: ev.handle,
        lane: ev.lane,
        kind: ev.type,
        detail:
          ev.type === "ready"
            ? (typeof ev.summary === "string" ? ev.summary : `${ev.handle} finished`)
            : (typeof ev.reason === "string" ? ev.reason : `${ev.handle} failed`),
        retryable: ev.type === "failed" ? ev.retryable === true : undefined,
        at: ev.at,
        read: false,
      };
    }

    /** The event → pending-action mapping (§6.4). */
    function confirmedAction(type: LifecycleEvent["type"]): PendingAction | null {
      switch (type) {
        case "accepted":
          return "submit";
        case "cancelled":
          return "cancel";
        case "retrying":
          return "retry";
        case "collected":
          return "collect";
        default:
          return null;
      }
    }

    function applyEvent(ev: LifecycleEvent): void {
      if (ev.id <= maxAppliedId) return; // dedupe: already applied (or replayed)
      maxAppliedId = ev.id;

      const wasKnown = get().tasksById.has(ev.task_id);
      // `accepted` is the only event that means the task is new to the SYSTEM.
      // Any other event on a task we have not seen means it already existed and
      // the server already counted it — treating that as an arrival would
      // double-count, and we cannot infer the status it left (a `cancelled`
      // event could have come from queued or from running). Counts for that
      // rare path are re-read from the server instead of guessed.
      const isArrival = ev.type === "accepted";
      const countable = wasKnown || isArrival;

      set((s) => {
        const tasksById = new Map(s.tasksById);
        const prev = tasksById.get(ev.task_id);
        const task = mutateTask(prev, ev);
        tasksById.set(task.id, task);

        const listOrder = reindex(s.listOrder, task, s.filters, tasksById);
        const counts = countable ? adjustCounts(s.counts, prev, task, s.filters) : s.counts;

        // Append a best-effort timeline entry if this task's detail is loaded.
        let historyById = s.historyById;
        const priorHistory = s.historyById.get(ev.task_id);
        if (priorHistory) {
          const entry: HistoryTransition = {
            event_type: ev.type,
            from_status: prev ? prev.status : null,
            to_status: task.status,
            at: ev.at,
            meta: extractMeta(ev),
          };
          historyById = new Map(s.historyById);
          historyById.set(ev.task_id, [...priorHistory, entry]);
        }

        const notice = noticeFor(ev);
        const notifications = notice ? [notice, ...s.notifications].slice(0, 50) : s.notifications;

        return { tasksById, listOrder, historyById, notifications, counts };
      });

      const action = confirmedAction(ev.type);
      if (action) clearPending(ev.task_id, action);

      // Backfill the static fields for a task we first learned of via a stream
      // event (§5.1) — the single event-driven read, still not polling.
      if (!wasKnown && api) {
        const client = api;
        void client
          .getById(ev.task_id)
          .then((fetched) => mergeServerTask(fetched))
          .catch(() => {
            /* transient; the next event or a resync will reconcile */
          });
        // Same rare path, same justification: we cannot maintain counts for a
        // task whose previous status we never saw, so we re-read them rather
        // than show a number we cannot stand behind.
        if (!isArrival) void refreshCounts();
      }
    }

    /** Re-read just the counts for the active filters. Single-flight: a burst
     * of unknown-task events produces one request, not one per event. */
    let countsRefreshInFlight = false;
    async function refreshCounts(): Promise<void> {
      if (!api || countsRefreshInFlight) return;
      countsRefreshInFlight = true;
      try {
        const snap = await api.listTasks(get().filters, { limit: 1 });
        if (snap.counts) set({ counts: snap.counts });
      } catch {
        /* transient; the next snapshot or resync will reconcile */
      } finally {
        countsRefreshInFlight = false;
      }
    }

    /** Merge an authoritative server task (backfill / detail fetch) without
     * regressing fresher event-driven fields. Static fields always adopt; the
     * dynamic status block adopts only when the fetch is at least as recent. */
    function mergeServerTask(fetched: Task): void {
      set((s) => {
        const prev = s.tasksById.get(fetched.id);
        const merged: Task = prev
          ? {
              ...prev,
              params: fetched.params,
              max_attempts: fetched.max_attempts,
              seeded: fetched.seeded,
              created_at: fetched.created_at,
              result: fetched.result,
              ...(fetched.updated_at >= prev.updated_at
                ? {
                    status: fetched.status,
                    error: fetched.error,
                    collected: fetched.collected,
                    attempts: fetched.attempts,
                    updated_at: fetched.updated_at,
                    handle: fetched.handle,
                  }
                : {}),
            }
          : fetched;
        const tasksById = new Map(s.tasksById);
        tasksById.set(merged.id, merged);
        const listOrder = reindex(s.listOrder, merged, s.filters, tasksById);
        // Only a task we already knew can move the counters here. Learning of a
        // task for the first time via a detail fetch is not an arrival — the
        // server counted it in the snapshot whether or not it was on our page.
        const counts = prev ? adjustCounts(s.counts, prev, merged, s.filters) : s.counts;
        return { tasksById, listOrder, counts };
      });
    }

    // ── stream lifecycle ────────────────────────────────────────────────────

    function subscribe(sinceId: number): void {
      sse?.close();
      if (!api) return;
      maxAppliedId = sinceId;
      sse = new SseClient({
        apiKey: api.key,
        sinceId,
        baseUrl,
        onEvent: applyEvent,
        onState: (connection: ConnectionState) => set({ connection }),
        onStale: () => void resync(),
      });
      sse.start();
    }

    /** Full resync after a prolonged disconnect (§5.3): fresh snapshot, then
     * re-subscribe from the new `as_of`. */
    async function resync(): Promise<void> {
      await hydrate(get().filters, { keepList: true });
    }

    async function hydrate(filters: TaskFilters, opts: { keepList?: boolean } = {}): Promise<void> {
      if (!api) return;
      set({ listStatus: "loading", listError: null, filters });
      try {
        const snap = await api.listTasks(filters, { limit: SNAPSHOT_LIMIT });
        const sort = parseSort(filters.sort);
        set((s) => {
          // Never drop known tasks on a filter change — detail views and
          // pending notifications reference them; only the visible listOrder
          // is replaced. On a resync (keepList) the live-added rows are kept.
          const tasksById = new Map(s.tasksById);
          for (const t of snap.tasks) tasksById.set(t.id, t);
          const order = sortIds(
            opts.keepList
              ? new Set([...s.listOrder.filter((id) => tasksById.has(id)), ...snap.tasks.map((t) => t.id)])
              : snap.tasks.map((t) => t.id),
            tasksById,
            sort
          );
          return {
            tasksById,
            listOrder: order,
            nextCursor: snap.next_cursor,
            asOf: snap.as_of,
            // Authoritative: every snapshot re-bases the counters, so any local
            // adjustment drift cannot accumulate across a filter change.
            counts: snap.counts ?? null,
            listStatus: "live" as ListStatus,
          };
        });
        subscribe(snap.as_of);
      } catch (err) {
        const e = err as ApiError;
        if (e.status === 401) return kickToGate();
        set({ listStatus: "error", listError: e.message });
      }
    }

    function kickToGate(): void {
      sse?.close();
      sse = null;
      api = null;
      for (const t of pendingTimers.values()) clearTimeout(t);
      pendingTimers.clear();
      maxAppliedId = 0;
      clearStoredKey();
      set({
        ...initialState(),
        apiKey: null,
        authStatus: "error",
        authError: "Your API key stopped working; enter a valid key to continue.",
      });
    }

    // ── public actions ──────────────────────────────────────────────────────

    async function signIn(key: string): Promise<void> {
      const trimmed = key.trim();
      set({ authStatus: "validating", authError: null });
      const client = new ApiClient(trimmed, baseUrl);
      try {
        await client.listTasks({}, { limit: 1 }); // real validation call
      } catch (err) {
        const e = err as ApiError;
        set({
          authStatus: "error",
          authError: e.isNetworkError ? "Could not reach the server." : "That key was not accepted.",
        });
        return;
      }
      api = client;
      setStoredKey(trimmed);
      set({ apiKey: trimmed, authStatus: "authenticated", authError: null });
      await hydrate(get().filters);
    }

    async function submit(input: SubmitInput): Promise<Task> {
      if (!api) throw new ApiError({ status: 401, code: "unauthorized", message: "Not signed in." });
      let task: Task;
      try {
        task = await api.submit(input);
      } catch (err) {
        // A stale key must land the user back at the gate from here too, the
        // same as it does from any other call (§4.1: "whenever ANY API call
        // returns 401"). The error still propagates so the caller can stop its
        // own pending state; the gate replaces the screen regardless.
        if ((err as ApiError).status === 401) kickToGate();
        throw err;
      }
      // Confirmation is the `accepted` event, not this 201 (§5 rule 3 / §6.4).
      //
      // Submit is the one action whose pending mark can only be set AFTER its
      // request resolves, because the task id does not exist until then — and
      // the `accepted` event is pushed the instant the transaction commits,
      // while the 201 still has to serialise and travel. On a local connection
      // the event reliably wins that race. Marking pending unconditionally
      // would then wait for a confirmation that had already passed, stranding
      // the button on "Submitting…" forever. If the task is already in the
      // store, the event landed and there is nothing left to wait for.
      if (!get().tasksById.has(task.id)) markPending(task.id, "submit");
      return task;
    }

    async function runAction(id: string, action: Exclude<PendingAction, "submit">): Promise<void> {
      const task = get().tasksById.get(id);
      if (!api || !task) return;
      markPending(id, action);
      set({ actionError: null });
      try {
        if (action === "cancel") await api.cancel(task.handle);
        else if (action === "retry") await api.retry(task.handle);
        else await api.collect(task.handle);
        // Success: keep pending until the confirming event applies.
      } catch (err) {
        const e = err as ApiError;
        clearPending(id, action);
        if (e.status === 401) return kickToGate();
        // 409 and friends: the store will be reconciled by the event stream;
        // surface the actual status for the UI's conflict toast (§4.4).
        set({
          actionError: {
            action,
            taskId: id,
            code: e.code,
            message: e.message,
            currentStatus: e.currentStatus,
          },
        });
      }
    }

    async function loadDetail(id: string): Promise<{ task: Task; history: HistoryTransition[] }> {
      if (!api) throw new ApiError({ status: 401, code: "unauthorized", message: "Not signed in." });
      const [task, history] = await Promise.all([api.getById(id), api.getHistory(id)]);
      mergeServerTask(task);
      set((s) => {
        const historyById = new Map(s.historyById);
        historyById.set(id, history.transitions);
        return { historyById };
      });
      return { task, history: history.transitions };
    }

    async function search(term: string, signal?: AbortSignal): Promise<SearchResult> {
      if (!api) throw new ApiError({ status: 401, code: "unauthorized", message: "Not signed in." });
      const res = await api.searchTasks(term, { signal });
      // There is deliberately no `set(...)` in this function. See the interface
      // doc above: search answers a different question from the register's, and
      // its rows must not become register rows.
      return { tasks: res.tasks, matching: res.counts?.matching ?? null };
    }

    return {
      ...initialState(),

      bootstrap: async () => {
        const key = get().apiKey;
        if (key) await signIn(key);
      },
      signIn,
      signOut: () => {
        sse?.close();
        sse = null;
        api = null;
        for (const t of pendingTimers.values()) clearTimeout(t);
        pendingTimers.clear();
        clearStoredKey();
        set({ ...initialState(), apiKey: null });
      },

      setFilters: (filters: TaskFilters) => hydrate(filters),
      refresh: () => hydrate(get().filters),
      loadMore: async () => {
        const { nextCursor, filters } = get();
        if (!api || !nextCursor) return;
        try {
          const page = await api.listTasks(filters, { limit: SNAPSHOT_LIMIT, cursor: nextCursor });
          set((s) => {
            const tasksById = new Map(s.tasksById);
            for (const t of page.tasks) tasksById.set(t.id, t);
            const order = sortIds(
              new Set([...s.listOrder, ...page.tasks.map((t) => t.id)]),
              tasksById,
              parseSort(filters.sort)
            );
            return { tasksById, listOrder: order, nextCursor: page.next_cursor };
          });
        } catch (err) {
          const e = err as ApiError;
          if (e.status === 401) kickToGate();
          else set({ listError: e.message });
        }
      },

      submit,
      cancel: (id: string) => runAction(id, "cancel"),
      retry: (id: string) => runAction(id, "retry"),
      collect: (id: string) => runAction(id, "collect"),

      loadDetail,
      search,

      markNotificationsRead: () =>
        set((s) => ({ notifications: s.notifications.map((n) => ({ ...n, read: true })) })),
      clearNotifications: () => set({ notifications: [] }),
      dismissActionError: () => set({ actionError: null }),
    };
  });
}

// ── Keeping counts truthful between snapshots (ADR 0018) ────────────────────
//
// A count must always match the list it opens, and snapshots only happen on
// hydration and filter changes — so between them the sidebar would drift as
// events land. It is NOT drift-prone to fix that locally: the event stream is
// complete for this user (every status change for every one of their tasks
// produces an event), so a known total plus a known delta is an EXACT result,
// not a client-side estimate of the kind frontend-brief §6.5 forbids. This is
// the same class of maintenance `reindex` already does for `listOrder`.
//
// The fiddly part is that each field has its own filter basis, so a task
// moving in or out of scope counts for some fields and not others.

function subsetFilters(filters: TaskFilters, keys: Array<keyof TaskFilters>): TaskFilters {
  const out: TaskFilters = {};
  for (const key of keys) {
    const value = filters[key];
    if (value !== undefined) out[key] = value as never;
  }
  return out;
}

function bump(target: Record<string, number>, key: string, delta: number): void {
  target[key] = Math.max(0, (target[key] ?? 0) + delta);
}

/**
 * Move the counters for one task's before/after states. `prev` undefined means
 * the task is new to us; `next` undefined means it left the store. Returns a
 * fresh object so React sees the change; returns `counts` untouched when there
 * is nothing to count against yet.
 */
export function adjustCounts(
  counts: Counts | null,
  prev: Task | undefined,
  next: Task | undefined,
  filters: TaskFilters
): Counts | null {
  if (!counts) return counts;
  if (!prev && !next) return counts;

  // The five bases of api-contract §6.2, as amended for `?uncollected=`. The
  // uncollected FILTER is scope for `matching`, `status.*` and `lane.*`; it is
  // NOT scope for `all`, and it is deliberately not scope for the `uncollected`
  // COUNT, which *is* that predicate — narrowing it by itself would make the
  // badge collapse to itself the instant a user pressed it.
  const dateOnly = subsetFilters(filters, ["from", "to"]);
  const laneDateOnly = subsetFilters(filters, ["lane", "from", "to"]);
  const laneDate = subsetFilters(filters, ["lane", "from", "to", "uncollected"]);
  const statusDate = subsetFilters(filters, ["status", "from", "to", "uncollected"]);

  const out: Counts = {
    ...counts,
    status: { ...counts.status },
    lane: { ...counts.lane },
  };

  // `all` — respects from/to only, so only arrivals and departures move it.
  if (prev && matchesFilters(prev, dateOnly)) out.all = Math.max(0, out.all - 1);
  if (next && matchesFilters(next, dateOnly)) out.all += 1;

  // `status.*` — respects lane/from/to/uncollected, ignores the status filter.
  if (prev && matchesFilters(prev, laneDate)) bump(out.status, prev.status, -1);
  if (next && matchesFilters(next, laneDate)) bump(out.status, next.status, +1);

  // `lane.*` — respects status/from/to/uncollected, ignores the lane filter.
  if (prev && matchesFilters(prev, statusDate)) bump(out.lane, prev.lane, -1);
  if (next && matchesFilters(next, statusDate)) bump(out.lane, next.lane, +1);

  // `uncollected` the count — lane/from/to only. It ignores `status` for the
  // same reason `status.*` does, and it ignores `uncollected` because it is the
  // number that opens that filter.
  if (prev && isUncollected(prev) && matchesFilters(prev, laneDateOnly)) {
    out.uncollected = Math.max(0, out.uncollected - 1);
  }
  if (next && isUncollected(next) && matchesFilters(next, laneDateOnly)) {
    out.uncollected += 1;
  }

  // `matching` — respects every active filter, exactly like `listOrder`.
  if (prev && matchesFilters(prev, filters)) out.matching = Math.max(0, out.matching - 1);
  if (next && matchesFilters(next, filters)) out.matching += 1;

  return out;
}

/** Pull the event's non-derivable payload into a history `meta` object,
 * dropping the correlation/envelope fields the timeline already shows. */
function extractMeta(ev: LifecycleEvent): Record<string, unknown> {
  const { id, type, handle, lane, task_id, at, ...rest } = ev;
  void id;
  void type;
  void handle;
  void lane;
  void task_id;
  void at;
  return rest;
}

// ── selectors (pure reads over state; the UI composes these) ─────────────────

/** The dashboard's visible tasks, in list order. */
export function selectVisibleTasks(s: StoreState): Task[] {
  const out: Task[] = [];
  for (const id of s.listOrder) {
    const t = s.tasksById.get(id);
    if (t) out.push(t);
  }
  return out;
}

/** Actions currently in flight for a task (for disabling buttons, §6.4). */
export function selectPending(s: StoreState, id: string): Set<PendingAction> {
  return s.pending.get(id) ?? new Set();
}

export function selectUnreadCount(s: StoreState): number {
  return s.notifications.reduce((n, notice) => n + (notice.read ? 0 : 1), 0);
}
