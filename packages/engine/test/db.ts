/**
 * Engine unit-test DB harness (test-plan.md §6, §3.2 conventions applied to
 * the engine's own `backburner_test_engine` database). Mirrors the shape of
 * packages/e2e/src/db.ts but is self-contained — the engine's tests must
 * not import from packages/e2e.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client, Pool } = pg;

const DEFAULT_ENGINE_TEST_DATABASE_URL =
  "postgres://postgres:postgres@localhost:5432/backburner_test_engine";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const MIGRATE_SCRIPT = path.join(REPO_ROOT, "scripts", "migrate.mjs");

export function getEngineTestDatabaseUrl(): string {
  return process.env.ENGINE_TEST_DATABASE_URL ?? DEFAULT_ENGINE_TEST_DATABASE_URL;
}

function getDatabaseName(): string {
  const url = new URL(getEngineTestDatabaseUrl());
  return decodeURIComponent(url.pathname.replace(/^\//, ""));
}

function getMaintenanceDatabaseUrl(): string {
  const url = new URL(getEngineTestDatabaseUrl());
  url.pathname = "/postgres";
  return url.toString();
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export async function createDatabaseIfMissing(): Promise<void> {
  const dbName = getDatabaseName();
  const client = new Client({ connectionString: getMaintenanceDatabaseUrl() });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (rows.length === 0) {
      await client.query(`CREATE DATABASE ${quoteIdentifier(dbName)}`);
    }
  } finally {
    await client.end();
  }
}

export async function runMigrations(): Promise<void> {
  const databaseUrl = getEngineTestDatabaseUrl();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [MIGRATE_SCRIPT, `--database-url=${databaseUrl}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
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

let sharedPool: InstanceType<typeof Pool> | null = null;

/** One pool shared across DB-backed test files in this process. */
export function getTestPool(): InstanceType<typeof Pool> {
  if (!sharedPool) {
    sharedPool = new Pool({ connectionString: getEngineTestDatabaseUrl() });
  }
  return sharedPool;
}

export interface TestUser {
  id: string;
  name: string;
}

/**
 * Truncates the engine's two owned tables and inserts a fresh test user
 * (the tasks FK needs a users row) — test-plan.md §6's per-test reset,
 * scoped to this package.
 */
export async function resetEngineTestDb(): Promise<TestUser> {
  const pool = getTestPool();
  await pool.query("TRUNCATE task_transitions, tasks, users RESTART IDENTITY CASCADE");
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (name, api_key_hash) VALUES ($1, $2) RETURNING id`,
    ["engine-test-user", `test-hash-${Math.random().toString(36).slice(2)}`]
  );
  const row = rows[0];
  if (!row) throw new Error("resetEngineTestDb: failed to insert test user");
  return { id: row.id, name: "engine-test-user" };
}

export async function insertTestUser(name = "engine-extra-user"): Promise<TestUser> {
  const pool = getTestPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (name, api_key_hash) VALUES ($1, $2) RETURNING id`,
    [name, `test-hash-${Math.random().toString(36).slice(2)}`]
  );
  const row = rows[0];
  if (!row) throw new Error("insertTestUser: failed to insert test user");
  return { id: row.id, name };
}
