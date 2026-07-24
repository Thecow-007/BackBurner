#!/usr/bin/env node
/**
 * @backburner/api entrypoint — docs/architecture.md §11, §13;
 * docs/test-plan.md §3.1. Compiles to `dist/server.js`, which the e2e
 * harness spawns directly. The exact sequence and the `BACKBURNER_READY`
 * line are a contract the harness parses verbatim — see the ordering notes
 * inline below before changing anything here.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { createEngine, createMockWorker } from "@backburner/engine";

import { buildApp } from "./app.js";
import { readConfig } from "./config.js";
import type { Config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/server.js lives at packages/api/dist/ — repo root is three levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "migrations");

/** Lanes registered with the engine, both backed by the mock worker
 * (api-contract §1 "Registered lanes"). */
const MOCK_WORKER_LANES: ReadonlySet<string> = new Set(["scrape", "report"]);

/**
 * Verifies every `.sql` file in the repo-root `migrations/` directory is
 * recorded as applied in `schema_migrations` (architecture §11 step 1, §13).
 * Does NOT run migrations itself in test — the e2e harness's globalSetup
 * already has. Throws with a clear message on any mismatch.
 */
async function verifyMigrations(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  let appliedVersions: Set<string>;
  try {
    const { rows } = await pool.query<{ version: string }>("SELECT version FROM schema_migrations");
    appliedVersions = new Set(rows.map((r) => r.version));
  } catch (err) {
    throw new Error(
      `could not read schema_migrations (${(err as Error).message}). ` +
        `Run "npm run migrate" against DATABASE_URL first.`
    );
  }

  const missing = files.filter((f) => !appliedVersions.has(f));
  if (missing.length > 0) {
    throw new Error(
      `the following migration(s) are not applied to the database: ${missing.join(", ")}. ` +
        `Run "npm run migrate" first.`
    );
  }
}

let shuttingDown = false;

async function main(): Promise<void> {
  // 1. Read env.
  let config: Config;
  try {
    config = readConfig();
  } catch (err) {
    console.error(`[api] configuration error: ${(err as Error).message}`);
    process.exit(1);
    return;
  }

  // 3. One shared pool — passed to the engine AND used directly for the
  // `users` auth lookups. Because a pool (not a connectionString) is
  // handed to createEngine, the engine will not close it; this process
  // owns its lifecycle end-to-end (architecture §2, §13).
  const pool = new pg.Pool({ connectionString: config.databaseUrl });

  // 2. Verify migrations before anything else touches the schema.
  try {
    await verifyMigrations(pool);
  } catch (err) {
    console.error(`[api] migration verification failed: ${(err as Error).message}`);
    await pool.end().catch(() => {});
    process.exit(1);
    return;
  }

  const worker = createMockWorker();
  const engine = createEngine({
    pool,
    concurrency: config.workerConcurrency,
    lanes: {
      scrape: { worker },
      report: { worker },
    },
    backoff: { baseMs: config.backoffBaseMs },
    drainTimeoutMs: config.drainTimeoutMs,
  });

  // 4. Boot recovery + initial dispatch MUST complete before the ready line.
  await engine.start();

  // 5. Build and bind the Fastify app.
  const app = await buildApp({
    engine,
    pool,
    sseHeartbeatMs: config.sseHeartbeatMs,
    mockWorkerLanes: MOCK_WORKER_LANES,
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });

  const address = app.server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : config.port;

  // 6. The ready line — exactly this shape, on stdout, after listen()
  // resolves and after engine.start() has completed. Nothing before this
  // point may print anything matching the harness's ready-line regex.
  console.log(`BACKBURNER_READY ${JSON.stringify({ port: actualPort })}`);

  // 7. SIGTERM: graceful drain, then close the app, then the pool. Guarded
  // against double-invocation. No SIGKILL handler is installed — crash
  // durability is the engine's boot-recovery path, proven by criterion 09.
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await engine.stop({ drain: true, drainTimeoutMs: config.drainTimeoutMs });
      await app.close();
      await pool.end();
    } catch (err) {
      console.error("[api] error during shutdown:", err);
    } finally {
      process.exit(0);
    }
  }

  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((err) => {
  console.error("[api] fatal startup error:", err);
  process.exit(1);
});
