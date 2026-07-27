import { createDatabaseIfMissing, resetDatabase, runMigrations } from "./db.js";

/**
 * Vitest `globalSetup` (test-plan.md §3.2): ensures the `backburner_test_e2e`
 * database exists, is migrated, and is **empty** before any test file in this
 * package runs. Idempotent — safe to run on every invocation of the suite,
 * and safe to run concurrently with the engine package's own global setup
 * since each targets a different database name.
 *
 * The truncation is not redundant with the per-test `resetDatabase()`. The
 * criteria suites truncate *before* spawning their server; the supplemental
 * suites spawn one server per FILE in `beforeAll` and only truncate in
 * `beforeEach` — so the first supplemental server of a run boots against
 * whatever the previous, unrelated run left behind. Boot recovery
 * (architecture §11) then legitimately re-queues those stale rows and the
 * dispatcher claims them, occupying worker slots with tasks whose rows the
 * next `beforeEach` truncates out from under them. At `WORKER_CONCURRENCY=1`
 * that is a multi-second stall with no trace in the new server's log — an
 * intermittent failure with an invisible cause, which is exactly what §9
 * rule 1 forbids leaving in place. Starting every run from an empty database
 * removes the precondition rather than widening a timeout.
 */
export default async function globalSetup(): Promise<void> {
  await createDatabaseIfMissing();
  await runMigrations();
  await resetDatabase();
}
