/**
 * @backburner/engine — public surface. docs/architecture.md §2. This is
 * the ONLY module @backburner/api may import from this package.
 */
export { createEngine } from "./engine.js";
export { InvalidStateError, NotFoundError, UnknownLaneError, ValidationError } from "./errors.js";
export {
  MOCK_DEFAULT_DURATION_RANGE,
  MOCK_LONG_DURATION_RANGE,
  createMockWorker,
  normalizeMockParams,
  randomDurationMs,
} from "./worker.js";
export type { DurationRange } from "./worker.js";

export type {
  BackoffOptions,
  Engine,
  EngineOptions,
  HistoryTransition,
  Job,
  LaneConfig,
  ListFilters,
  TaskCounts,
  TaskObject,
  TaskStatus,
  Worker,
  WorkerContext,
  WorkerResult,
} from "./types.js";
