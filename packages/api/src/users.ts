/**
 * Seed-user provisioning — docs/architecture.md §12. `@backburner/api` owns
 * the `users` table (docs/architecture.md §3); this module and `auth.ts` are
 * the only writers/readers of it. The seed CLI (scripts/seed.mjs) composes
 * these helpers with the engine's internal seed module: the engine module
 * writes `tasks`/`task_transitions`, this module writes `users`, so the
 * package table-ownership rules hold even for seeding.
 *
 * Not re-exported from the api entrypoint (dist/server.js) — the seed script
 * imports this compiled module directly by path, exactly as it imports the
 * engine's internal seed module.
 */
import type { Pool } from "pg";

import { hashApiKey } from "./auth.js";

/**
 * Upsert a seed user **by name**, rotating its API key to `rawKey`. Returns
 * the (stable) user id. Used by a full seed run, which generates a fresh key
 * for each seed user and prints it once. Rotation is safe because each seed
 * user name maps to exactly one row across the whole lifecycle (this function
 * is the only inserter of them), so the UPDATE never touches more than one
 * row and can never collide on the `api_key_hash` UNIQUE index.
 */
export async function upsertSeedUser(pool: Pool, name: string, rawKey: string): Promise<string> {
  const hash = hashApiKey(rawKey);
  const updated = await pool.query<{ id: string }>(
    "UPDATE users SET api_key_hash = $2 WHERE name = $1 RETURNING id",
    [name, hash]
  );
  const existing = updated.rows[0];
  if (existing) return existing.id;

  const inserted = await pool.query<{ id: string }>(
    "INSERT INTO users (name, api_key_hash) VALUES ($1, $2) RETURNING id",
    [name, hash]
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("upsertSeedUser: INSERT ... RETURNING produced no row");
  return row.id;
}

/**
 * Ensure a seed user exists **without rotating** an existing key. Inserts with
 * `rawKey` only when the user is missing; otherwise returns the existing id
 * and leaves its key untouched. Used by `--reset`, which per architecture §12
 * "upserts — never deletes — the seed users" but must not invalidate a key a
 * reviewer is already holding.
 */
export async function ensureSeedUser(pool: Pool, name: string, rawKey: string): Promise<string> {
  const existing = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE name = $1",
    [name]
  );
  const row = existing.rows[0];
  if (row) return row.id;
  return upsertSeedUser(pool, name, rawKey);
}
