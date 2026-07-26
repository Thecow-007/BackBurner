/**
 * @backburner/web — public surface of the SPA's data layer.
 *
 * A pure API consumer: `fetch` + `EventSource` only. Never imports
 * `@backburner/engine` or `@backburner/api`, never touches the database
 * (docs/architecture.md §1, §3). This module exports the NON-visual
 * foundation — types, HTTP client, SSE client, the Zustand store, and pure
 * helpers — that the React components (screens, routing, styling) sit on top
 * of. The store enforces the live-update discipline in docs/frontend-brief.md
 * §5 so the UI layer only ever renders store state and dispatches actions.
 */
export const WEB_PACKAGE_NAME = "@backburner/web";

// Data shapes (api-contract §4/§8 mirror).
export type {
  ConnectionState,
  Counts,
  ErrorEnvelope,
  EventType,
  HistoryResponse,
  HistoryTransition,
  LifecycleEvent,
  MockResult,
  NotificationNotice,
  PendingAction,
  SubmitInput,
  Task,
  TaskError,
  TaskFilters,
  TaskListResponse,
  TaskStatus,
} from "./lib/types.js";

// HTTP client.
export { ApiClient, ApiError } from "./lib/api.js";
export type { ListOptions } from "./lib/api.js";

// SSE client.
export { SseClient } from "./lib/sse.js";
export type { SseClientOptions } from "./lib/sse.js";

// Pure helpers.
export { compareTasks, matchesFilters, parseSort, sortIds } from "./lib/filters.js";
export type { ParsedSort, SortDir, SortField } from "./lib/filters.js";
export { allowedActions } from "./lib/matrix.js";
export type { AllowedActions } from "./lib/matrix.js";

// Presentation derivation — the single source for how a status LOOKS, paired
// with matrix.ts as the single source for what it PERMITS.
export { durationReadout, isLive, stateNote, statusPresentation, STATUS_ORDER } from "./lib/status.js";
export type { DurationReadout, StatusPresentation } from "./lib/status.js";
export {
  durationBetween,
  formatAttempts,
  formatClock,
  formatDuration,
  formatElapsedClock,
  formatRelative,
  humanizeMs,
  maskKey,
  prettyJson,
} from "./lib/format.js";

// Local persistence.
export {
  clearStoredKey,
  getLaneDefault,
  getLaneDefaults,
  getStoredKey,
  setLaneDefault,
  setStoredKey,
} from "./lib/storage.js";
export type { LaneDefaults } from "./lib/storage.js";

// The store.
export {
  adjustCounts,
  createBackburnerStore,
  selectPending,
  selectUnreadCount,
  selectVisibleTasks,
} from "./store/store.js";
export type {
  ActionError,
  AuthStatus,
  BackburnerStore,
  ListStatus,
  StoreActions,
  StoreState,
} from "./store/store.js";
