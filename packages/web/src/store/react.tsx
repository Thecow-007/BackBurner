/**
 * The React binding over the vanilla store. The store (`store.ts`) is the
 * brain and is framework-agnostic; this file is the ONLY bridge between it and
 * the component tree. Screens consume server state exclusively through these
 * hooks — they never construct an `ApiClient`, never open an `EventSource`,
 * and never call `fetch` (docs/orchestration-brief.md §7).
 *
 * Selector discipline: `selectVisibleTasks` and friends in `store.ts` allocate
 * a new array per call, which would loop forever under `useSyncExternalStore`.
 * The hooks here select only referentially stable slices (`listOrder`,
 * `tasksById`, a `Map.get` result) and derive with `useMemo`, so a render only
 * happens when the underlying slice was actually replaced.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useStore as useZustandStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import { formatClock } from "../lib/format.js";
import type {
  ConnectionState,
  Counts,
  HistoryTransition,
  NotificationNotice,
  PendingAction,
  Task,
} from "../lib/types.js";
import {
  createBackburnerStore,
  type ActionError,
  type AuthStatus,
  type BackburnerStore,
  type ListStatus,
  type StoreActions,
} from "./store.js";

const StoreContext = createContext<StoreApi<BackburnerStore> | null>(null);

export interface StoreProviderProps {
  children: ReactNode;
  /** Tests inject a pre-seeded store; the app creates its own. */
  store?: StoreApi<BackburnerStore>;
  /** Tests that drive state directly skip the boot handshake. */
  autoBootstrap?: boolean;
}

export function StoreProvider({
  children,
  store,
  autoBootstrap = true,
}: StoreProviderProps): ReactElement {
  const [api] = useState(() => store ?? createBackburnerStore());
  const booted = useRef(false);

  useEffect(() => {
    if (!autoBootstrap || booted.current) return;
    // StrictMode mounts effects twice in development; bootstrap validates a
    // key and opens a stream, so it must happen exactly once.
    booted.current = true;
    void api.getState().bootstrap();
  }, [api, autoBootstrap]);

  return <StoreContext.Provider value={api}>{children}</StoreContext.Provider>;
}

export function useStoreApi(): StoreApi<BackburnerStore> {
  const api = useContext(StoreContext);
  if (!api) throw new Error("useStoreApi must be used inside <StoreProvider>.");
  return api;
}

/** The general escape hatch. Prefer the named hooks below — they already pick
 * stable slices, which is the easy thing to get wrong here. */
export function useStore<T>(selector: (state: BackburnerStore) => T): T {
  return useZustandStore(useStoreApi(), selector);
}

/**
 * The mutating actions. These live on the state object and never change
 * identity, so this object is built once per store and is safe in dependency
 * arrays.
 */
export function useActions(): StoreActions {
  const api = useStoreApi();
  return useMemo(() => {
    const s = api.getState();
    return {
      bootstrap: s.bootstrap,
      signIn: s.signIn,
      signOut: s.signOut,
      setFilters: s.setFilters,
      refresh: s.refresh,
      loadMore: s.loadMore,
      submit: s.submit,
      cancel: s.cancel,
      retry: s.retry,
      collect: s.collect,
      loadDetail: s.loadDetail,
      search: s.search,
      markNotificationsRead: s.markNotificationsRead,
      clearNotifications: s.clearNotifications,
      dismissActionError: s.dismissActionError,
    };
  }, [api]);
}

// ── Task data ───────────────────────────────────────────────────────────────

/** The register's visible rows, in list order. */
export function useVisibleTasks(): Task[] {
  const listOrder = useStore((s) => s.listOrder);
  const tasksById = useStore((s) => s.tasksById);
  return useMemo(() => {
    const out: Task[] = [];
    for (const id of listOrder) {
      const task = tasksById.get(id);
      if (task) out.push(task);
    }
    return out;
  }, [listOrder, tasksById]);
}

export function useTask(id: string | undefined): Task | undefined {
  return useStore((s) => (id === undefined ? undefined : s.tasksById.get(id)));
}

export function useHistory(id: string | undefined): HistoryTransition[] | undefined {
  return useStore((s) => (id === undefined ? undefined : s.historyById.get(id)));
}

export interface ListView {
  status: ListStatus;
  error: string | null;
  hasMore: boolean;
}

export function useListView(): ListView {
  const status = useStore((s) => s.listStatus);
  const error = useStore((s) => s.listError);
  const nextCursor = useStore((s) => s.nextCursor);
  return useMemo(
    () => ({ status, error, hasMore: nextCursor !== null }),
    [status, error, nextCursor]
  );
}

export function useFilters(): BackburnerStore["filters"] {
  return useStore((s) => s.filters);
}

/** `null` until the first snapshot lands. Render a neutral placeholder when it
 * is null — NEVER a number derived from the loaded page (frontend-brief §6.5). */
export function useCounts(): Counts | null {
  return useStore((s) => s.counts);
}

// ── Pending actions (§6.4) ──────────────────────────────────────────────────

const EMPTY_PENDING: ReadonlySet<PendingAction> = new Set<PendingAction>();

export function usePending(id: string | undefined): ReadonlySet<PendingAction> {
  const pending = useStore((s) => (id === undefined ? undefined : s.pending.get(id)));
  return pending ?? EMPTY_PENDING;
}

/** True from the moment the control is pressed until the CONFIRMING EVENT
 * lands — not until the HTTP response returns (docs/ui-spec.md §0). */
export function useIsPending(id: string | undefined, action: PendingAction): boolean {
  return useStore((s) => (id === undefined ? false : (s.pending.get(id)?.has(action) ?? false)));
}

export function useActionError(): ActionError | null {
  return useStore((s) => s.actionError);
}

// ── Session + connection ────────────────────────────────────────────────────

export function useAuth(): { status: AuthStatus; error: string | null; apiKey: string | null } {
  const status = useStore((s) => s.authStatus);
  const error = useStore((s) => s.authError);
  const apiKey = useStore((s) => s.apiKey);
  return useMemo(() => ({ status, error, apiKey }), [status, error, apiKey]);
}

export function useConnection(): ConnectionState {
  return useStore((s) => s.connection);
}

/**
 * The connection indicator's "as of 15:07:42" — a HUMAN CLOCK, not the event
 * cursor (docs/ui-spec.md §3.9). While the stream is healthy the view is
 * current as of now, so it ticks; the moment the stream drops it freezes at
 * the last instant we could vouch for, which is the honest thing to show.
 */
export function useAsOfClock(): { label: string; live: boolean } {
  const live = useConnection() === "live";
  const [asOf, setAsOf] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    setAsOf(Date.now());
    const id = setInterval(() => setAsOf(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);

  return { label: formatClock(asOf), live };
}

/**
 * A ticking clock for elapsed-time readouts. Presentational only: it re-renders
 * a duration the client can compute from timestamps it already holds. It issues
 * no requests, and the store is never touched — this is not polling
 * (frontend-brief §5 rule 4).
 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

// ── Notifications (§7) ──────────────────────────────────────────────────────

export function useNotifications(): NotificationNotice[] {
  return useStore((s) => s.notifications);
}

export function useUnreadCount(): number {
  return useStore((s) => {
    let unread = 0;
    for (const notice of s.notifications) if (!notice.read) unread += 1;
    return unread;
  });
}

/**
 * Notices that have not yet been shown as a toast. The store keeps the full
 * (capped) list for the notification centre; the toast layer needs to know
 * which are NEW to it, so it tracks what it has already surfaced by event id —
 * the same dedupe key the store uses, so a post-reconnect replay never
 * double-toasts.
 */
export function useToastQueue(): {
  pending: NotificationNotice[];
  markShown: (eventId: number) => void;
} {
  const notifications = useNotifications();
  const [shown, setShown] = useState<ReadonlySet<number>>(() => new Set<number>());

  const markShown = useCallback((eventId: number) => {
    setShown((prev) => (prev.has(eventId) ? prev : new Set(prev).add(eventId)));
  }, []);

  const pending = useMemo(
    () => notifications.filter((notice) => !shown.has(notice.eventId)),
    [notifications, shown]
  );

  return { pending, markShown };
}
