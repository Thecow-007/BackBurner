/**
 * Auth — docs/api-contract.md §2. `@backburner/api` owns the `users` table
 * (docs/architecture.md §3); this is the one module that queries it, and
 * the only SQL surface in this package that isn't the engine's public
 * surface.
 */
import { createHash } from "node:crypto";

import type { FastifyRequest } from "fastify";
import type { Pool } from "pg";

import { UnauthorizedError } from "./errors.js";

/** `sha256(rawKey)` hex — matches the stored `users.api_key_hash` scheme. */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

async function lookupUserId(pool: Pool, rawKey: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE api_key_hash = $1",
    [hashApiKey(rawKey)]
  );
  return rows[0]?.id ?? null;
}

/** `Authorization: Bearer <key>` — returns the raw key, or `null` if the
 * header is missing, has the wrong scheme, or carries an empty key. */
function extractBearerKey(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer (.+)$/.exec(header);
  const key = match?.[1];
  return key && key.length > 0 ? key : null;
}

/**
 * Every endpoint except `GET /health` and `GET /events` (api-contract §2):
 * `Authorization` header only. `?api_key=` is never accepted here, even if
 * present — missing/malformed header or unknown key is a uniform 401.
 */
export async function authenticate(request: FastifyRequest, pool: Pool): Promise<string> {
  const key = extractBearerKey(request.headers.authorization);
  if (!key) throw new UnauthorizedError();
  const userId = await lookupUserId(pool, key);
  if (!userId) throw new UnauthorizedError();
  return userId;
}

/**
 * `/events` only (api-contract §2): if an `Authorization` header is
 * present at all, it MUST be valid — a malformed/invalid header is 401
 * even when a valid `?api_key=` is also supplied. Only when no
 * `Authorization` header is present does `?api_key=` apply.
 */
export async function authenticateEvents(request: FastifyRequest, pool: Pool): Promise<string> {
  if (request.headers.authorization !== undefined) {
    const key = extractBearerKey(request.headers.authorization);
    if (!key) throw new UnauthorizedError();
    const userId = await lookupUserId(pool, key);
    if (!userId) throw new UnauthorizedError();
    return userId;
  }

  const query = request.query as Record<string, unknown> | undefined;
  const apiKeyParam = query?.["api_key"];
  if (typeof apiKeyParam !== "string" || apiKeyParam.length === 0) {
    throw new UnauthorizedError();
  }
  const userId = await lookupUserId(pool, apiKeyParam);
  if (!userId) throw new UnauthorizedError();
  return userId;
}
