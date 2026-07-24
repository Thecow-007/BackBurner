/**
 * Request validation — docs/api-contract.md §6.1, §7.
 *
 * `POST /tasks`'s body is validated by hand rather than through Fastify's
 * JSON-schema mechanism. Reason: Fastify's default ajv compiler runs with
 * `removeAdditional: true` (`@fastify/ajv-compiler`'s defaults), which
 * *silently strips* properties instead of rejecting them whenever a schema
 * sets `additionalProperties: false` — exactly the "unknown top-level field
 * -> 400 invalid_params" rule this endpoint needs (api-contract §6.1: "the
 * free-form area is `params`, nothing else"). Hand-rolled validation gives
 * full, unsurprising control; `GET /tasks`'s querystring has no such
 * additional-properties requirement, so it keeps a plain JSON schema.
 */
import { ValidationError } from "@backburner/engine";

export interface ParsedSubmitBody {
  lane: string;
  params: Record<string, unknown>;
  maxAttempts: number | undefined;
}

const ALLOWED_TOP_LEVEL_KEYS = new Set(["lane", "params", "max_attempts"]);

/** Validates and normalizes a `POST /tasks` body (api-contract §6.1).
 * Throws `ValidationError` (-> 400 invalid_params) on any violation.
 * `params`'s inner shape (`duration_ms`/`fail`/`fail_permanent`) is
 * validated later by `normalizeMockParams` for the registered mock-worker
 * lanes — this function only enforces the request-body envelope itself. */
export function parseSubmitBody(raw: unknown): ParsedSubmitBody {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError("request body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;

  for (const key of Object.keys(body)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      throw new ValidationError(`unknown field "${key}" in request body`);
    }
  }

  const { lane, params, max_attempts: maxAttemptsRaw } = body;

  if (typeof lane !== "string" || lane.length < 1) {
    throw new ValidationError('"lane" is required and must be a non-empty string');
  }

  let parsedParams: Record<string, unknown> = {};
  if (params !== undefined) {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      throw new ValidationError('"params" must be an object');
    }
    parsedParams = params as Record<string, unknown>;
  }

  let maxAttempts: number | undefined;
  if (maxAttemptsRaw !== undefined) {
    if (
      typeof maxAttemptsRaw !== "number" ||
      !Number.isInteger(maxAttemptsRaw) ||
      maxAttemptsRaw < 1 ||
      maxAttemptsRaw > 10
    ) {
      throw new ValidationError('"max_attempts" must be an integer between 1 and 10');
    }
    maxAttempts = maxAttemptsRaw;
  }

  return { lane, params: parsedParams, maxAttempts };
}

/** `GET /tasks` querystring (api-contract §7). Deliberately permissive on
 * unknown query keys (no `additionalProperties: false`) — only the five
 * declared fields are ever read out of `request.query` by the route
 * handler, so stray keys are harmless. Fastify's default ajv coercion
 * (`coerceTypes: 'array'`) turns the querystring's string `limit` into a
 * number before this schema's `minimum`/`maximum` apply. */
export const listQuerySchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["queued", "running", "ready", "failed", "cancelled"] },
    lane: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    sort: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 200 },
    cursor: { type: "string" },
  },
} as const;
