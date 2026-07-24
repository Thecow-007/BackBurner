/**
 * Environment configuration — docs/architecture.md §13, build-plan Phase 3
 * task list. The engine never reads `process.env` itself (architecture §2);
 * this module is the one place the api reads it, and every value is passed
 * through explicitly to `createEngine` / the auth module / the server.
 */

export interface Config {
  databaseUrl: string;
  port: number;
  workerConcurrency: number;
  backoffBaseMs: number;
  sseHeartbeatMs: number;
  drainTimeoutMs: number;
  nodeEnv: string | undefined;
}

function parseIntSafe(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    throw new Error(`invalid integer value for ${name}: "${value}"`);
  }
  return parsed;
}

/**
 * Reads and validates configuration from `process.env`. Throws on a missing
 * `DATABASE_URL` or a malformed integer knob — callers (server.ts) are
 * expected to catch, print to stderr, and `process.exit(1)`.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required but was not set");
  }

  return {
    databaseUrl,
    port: parseIntSafe(env.PORT, 3000, "PORT"),
    workerConcurrency: parseIntSafe(env.WORKER_CONCURRENCY, 4, "WORKER_CONCURRENCY"),
    backoffBaseMs: parseIntSafe(env.BACKOFF_BASE_MS, 2000, "BACKOFF_BASE_MS"),
    sseHeartbeatMs: parseIntSafe(env.SSE_HEARTBEAT_MS, 20000, "SSE_HEARTBEAT_MS"),
    drainTimeoutMs: parseIntSafe(env.DRAIN_TIMEOUT_MS, 30000, "DRAIN_TIMEOUT_MS"),
    nodeEnv: env.NODE_ENV,
  };
}
