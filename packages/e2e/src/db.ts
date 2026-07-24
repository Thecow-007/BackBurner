import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { TEST_USERS } from "./users.js";

const { Client } = pg;

const DEFAULT_E2E_DATABASE_URL =
  "postgres://postgres:postgres@localhost:5432/backburner_test_e2e";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const MIGRATE_SCRIPT = path.join(REPO_ROOT, "scripts", "migrate.mjs");

/** Connection string for the e2e test database (test-plan.md §3.2). */
export function getE2eDatabaseUrl(): string {
  return process.env.E2E_DATABASE_URL ?? DEFAULT_E2E_DATABASE_URL;
}

function getDatabaseName(): string {
  const url = new URL(getE2eDatabaseUrl());
  return decodeURIComponent(url.pathname.replace(/^\//, ""));
}

/** Same server, `postgres` maintenance database (test-plan.md §3.2). */
function getMaintenanceDatabaseUrl(): string {
  const url = new URL(getE2eDatabaseUrl());
  url.pathname = "/postgres";
  return url.toString();
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Creates the e2e test database on the target Postgres server if it does not
 * already exist, by connecting to the server's `postgres` maintenance
 * database (test-plan.md §3.2). Idempotent; safe to call on every run.
 */
export async function createDatabaseIfMissing(): Promise<void> {
  const dbName = getDatabaseName();
  const client = new Client({ connectionString: getMaintenanceDatabaseUrl() });
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName]
    );
    if (rows.length === 0) {
      // CREATE DATABASE cannot be parameterized. dbName is not user input —
      // it comes from E2E_DATABASE_URL / the fixed default — but it is
      // quoted as an identifier defensively rather than interpolated raw.
      await client.query(`CREATE DATABASE ${quoteIdentifier(dbName)}`);
    }
  } finally {
    await client.end();
  }
}

/**
 * Runs the repository migration runner (`scripts/migrate.mjs`) against the
 * e2e test database as a child process (test-plan.md §3.2). Idempotent;
 * throws with the captured stdout/stderr on a non-zero exit code.
 */
export async function runMigrations(): Promise<void> {
  const databaseUrl = getE2eDatabaseUrl();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [MIGRATE_SCRIPT, `--database-url=${databaseUrl}`],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      reject(new Error(`runMigrations: failed to spawn scripts/migrate.mjs: ${err.message}`));
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `runMigrations: scripts/migrate.mjs exited with code ${code} against ${databaseUrl}.\n` +
              `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
          )
        );
      }
    });
  });
}

interface PgError {
  code?: string;
  message: string;
}

function isUndefinedTableError(err: unknown): err is PgError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "42P01"
  );
}

/**
 * Per-test reset (test-plan.md §3.2, `beforeEach`):
 * `TRUNCATE task_transitions, tasks RESTART IDENTITY CASCADE;` then upsert
 * the two fixed test users (users.ts). This — plus `createDatabaseIfMissing`
 * / `runMigrations` above — is the entire SQL surface of the e2e package;
 * assertions never touch the database.
 *
 * Phase 1 note: `tasks`, `task_transitions`, and `users` do not exist until
 * Phase 2/3 land their migrations. Until then this throws on purpose — that
 * is what makes the criteria suite fail for the right reason (Gate A). The
 * 42P01 (undefined_table) case is caught and rethrown with an explicit,
 * self-explaining message; every other error propagates unchanged.
 */
export async function resetDatabase(): Promise<void> {
  const client = new Client({ connectionString: getE2eDatabaseUrl() });
  await client.connect();
  try {
    await client.query("TRUNCATE task_transitions, tasks RESTART IDENTITY CASCADE");
    for (const user of TEST_USERS) {
      await client.query(
        `INSERT INTO users (name, api_key_hash)
         VALUES ($1, $2)
         ON CONFLICT (api_key_hash) DO UPDATE SET name = EXCLUDED.name`,
        [user.name, user.apiKeyHash]
      );
    }
  } catch (err) {
    if (isUndefinedTableError(err)) {
      throw new Error(
        `schema not migrated yet: ${err.message} — expected until Phase 2 lands the engine migrations`
      );
    }
    throw err;
  } finally {
    await client.end();
  }
}
