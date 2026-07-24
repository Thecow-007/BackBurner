/**
 * Pool + transaction helper. The engine never reads process.env
 * (docs/architecture.md §2) — the pool is built from explicit
 * EngineOptions only.
 */
import pg from "pg";
import type { Pool, PoolClient } from "pg";

export function createPool(opts: { pool?: Pool; connectionString?: string }): Pool {
  if (opts.pool) return opts.pool;
  if (!opts.connectionString) {
    throw new Error("createEngine requires either `pool` or `connectionString`");
  }
  return new pg.Pool({ connectionString: opts.connectionString });
}

/**
 * Runs `fn` inside BEGIN/COMMIT, rolling back on any thrown error. The
 * client is always released back to the pool.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // rollback failure is secondary to the original error
    }
    throw err;
  } finally {
    client.release();
  }
}
