import { createDatabaseIfMissing, runMigrations } from "./db.js";

/**
 * Vitest `globalSetup` (test-plan.md §6, §3.2 applied to the engine
 * package): ensures `backburner_test_engine` exists and is migrated before
 * any DB-backed test file runs. Idempotent.
 */
export default async function globalSetup(): Promise<void> {
  await createDatabaseIfMissing();
  await runMigrations();
}
