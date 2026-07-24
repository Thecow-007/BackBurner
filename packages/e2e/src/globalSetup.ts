import { createDatabaseIfMissing, runMigrations } from "./db.js";

/**
 * Vitest `globalSetup` (test-plan.md §3.2): ensures the `backburner_test_e2e`
 * database exists and is migrated before any test file in this package runs.
 * Idempotent — safe to run on every invocation of the suite, and safe to run
 * concurrently with the engine package's own global setup since each targets
 * a different database name.
 */
export default async function globalSetup(): Promise<void> {
  await createDatabaseIfMissing();
  await runMigrations();
}
