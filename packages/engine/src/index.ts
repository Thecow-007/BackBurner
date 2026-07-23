/**
 * @backburner/engine — orchestration core (Phase 0 stub).
 *
 * This package will own handle allocation, the task state machine, dispatch,
 * the worker pool, retries, recovery, and the event log — see
 * docs/architecture.md. It has no HTTP dependencies and depends only on `pg`.
 *
 * No engine logic exists yet. Phase 2 (docs/build-plan.md) fills this in with
 * `createEngine(...)` and the public surface documented in architecture.md §2.
 */
export const ENGINE_PACKAGE_NAME = "@backburner/engine";
