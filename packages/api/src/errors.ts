/**
 * Error envelope mapping — docs/api-contract.md §3. Every non-2xx response
 * (aside from an already-open SSE stream) carries
 * `{ error: { code, message, ...context } }`. Engine errors map 1:1 to HTTP
 * statuses via `instanceof` (docs/architecture.md §2); Fastify's own
 * validation/body-parse failures and anything unexpected are intercepted
 * here too, so the raw framework error never leaks to a client.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { InvalidStateError, NotFoundError, UnknownLaneError, ValidationError } from "@backburner/engine";

/** API-owned — not part of the engine's error vocabulary (auth is entirely
 * an api concern; the engine never sees a userId until after auth). */
export class UnauthorizedError extends Error {
  readonly name = "UnauthorizedError";
  constructor(message = "missing, malformed, or unknown API key") {
    super(message);
    Object.setPrototypeOf(this, UnauthorizedError.prototype);
  }
}

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    [key: string]: unknown;
  };
}

function envelope(code: string, message: string, extra?: Record<string, unknown>): ErrorEnvelope {
  return { error: { code, message, ...extra } };
}

/** Fastify's automatic schema-validation failures set `err.validation`
 * (an array) and `err.code === 'FST_ERR_VALIDATION'`. */
function isFastifySchemaValidationError(err: unknown): err is Error & { validation: unknown[] } {
  return (
    typeof err === "object" &&
    err !== null &&
    Array.isArray((err as { validation?: unknown }).validation)
  );
}

function hasStatusCode(err: unknown): err is Error & { statusCode: number } {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { statusCode?: unknown }).statusCode === "number"
  );
}

/**
 * Registers the global error handler and 404 handler (api-contract §3, §9).
 * Must be registered before routes so it is active for every request.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: Error, _request: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof UnauthorizedError) {
      reply.code(401).send(envelope("unauthorized", err.message));
      return;
    }
    if (err instanceof UnknownLaneError) {
      reply.code(400).send(envelope("unknown_lane", err.message, { lane: err.lane }));
      return;
    }
    if (err instanceof ValidationError) {
      reply.code(400).send(envelope("invalid_params", err.message));
      return;
    }
    if (err instanceof NotFoundError) {
      reply.code(404).send(envelope("not_found", err.message));
      return;
    }
    if (err instanceof InvalidStateError) {
      reply.code(409).send(envelope("invalid_state", err.message, { current_status: err.current_status }));
      return;
    }
    if (isFastifySchemaValidationError(err)) {
      reply.code(400).send(envelope("invalid_params", err.message));
      return;
    }
    if (err instanceof SyntaxError) {
      // Fastify's default JSON body parser rethrows JSON.parse's
      // SyntaxError with statusCode=400 on a malformed body — intercepted
      // here rather than leaked raw (api-contract §3).
      reply.code(400).send(envelope("invalid_params", "request body is not valid JSON"));
      return;
    }
    if (hasStatusCode(err) && err.statusCode >= 400 && err.statusCode < 500) {
      // Any other Fastify-originated 4xx (e.g. an empty body with
      // Content-Type: application/json) — still never leak the raw
      // framework error, still the standard envelope.
      reply.code(400).send(envelope("invalid_params", err.message || "invalid request"));
      return;
    }

    app.log.error(err);
    reply.code(500).send(envelope("internal_error", "an unexpected error occurred"));
  });

  app.setNotFoundHandler((_request: FastifyRequest, reply: FastifyReply) => {
    // SPA serving is Phase 5 — every non-API route 404s with the envelope
    // for now (api-contract §9).
    reply.code(404).send(envelope("not_found", "no such route"));
  });
}
