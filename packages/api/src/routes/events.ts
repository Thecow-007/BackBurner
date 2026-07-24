/**
 * `GET /events` — the SSE lifecycle stream (docs/api-contract.md §8).
 * Auth can still fail with an ordinary JSON 401/400 before the stream
 * opens; once headers are written, no further HTTP status can be conveyed
 * (api-contract §3).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import { ValidationError } from "@backburner/engine";
import type { Engine } from "@backburner/engine";

import { authenticateEvents } from "../auth.js";

export interface EventsRouteOptions {
  engine: Engine;
  pool: Pool;
  sseHeartbeatMs: number;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** A string of digits only — `?since=`/`Last-Event-ID` must be a
 * non-negative integer (api-contract §6.9, §8). */
function isNonNegativeIntegerString(value: string): boolean {
  return /^\d+$/.test(value);
}

/**
 * Resolves the resume cursor (api-contract §8 "Catch-up"):
 * `Last-Event-ID` header wins over `?since` when both are present; a
 * present-but-malformed `Last-Event-ID` falls through to `?since` (the
 * contract only mandates a 400 for a malformed `?since`); a present
 * `?since` that fails to parse is `400 invalid_params`; neither present
 * means live-only from the connection's `latestEventId`.
 */
async function resolveSinceId(
  request: FastifyRequest,
  engine: Engine,
  userId: string
): Promise<number> {
  const lastEventIdHeader = firstHeaderValue(request.headers["last-event-id"]);
  if (lastEventIdHeader !== undefined && isNonNegativeIntegerString(lastEventIdHeader)) {
    return Number(lastEventIdHeader);
  }

  const query = request.query as Record<string, unknown>;
  const sinceRaw = query["since"];
  if (sinceRaw !== undefined) {
    if (typeof sinceRaw !== "string" || !isNonNegativeIntegerString(sinceRaw)) {
      throw new ValidationError('"since" must be a non-negative integer');
    }
    return Number(sinceRaw);
  }

  // Neither present: live-only from the moment of connection.
  return engine.latestEventId(userId);
}

export async function registerEventsRoute(app: FastifyInstance, opts: EventsRouteOptions): Promise<void> {
  const { engine, pool, sseHeartbeatMs } = opts;

  app.get("/events", async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await authenticateEvents(request, pool);
    const sinceId = await resolveSinceId(request, engine, userId);

    // Errors above are ordinary JSON responses via the global error
    // handler. From here on the stream is committed — hijack so Fastify
    // never tries to serialize/end the response itself.
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Node buffers headers until the first `write()` otherwise; a client
    // that connects with no history to replay and no live event yet (every
    // criteria ES connects before its first submit) would never see
    // `onopen` fire until something happened to be written. Flush
    // immediately so the stream is observably "open" the moment it's
    // accepted, independent of when the first event/heartbeat arrives.
    res.flushHeaders();

    let closed = false;
    let notifyClosed: (() => void) | undefined;
    const closedPromise = new Promise<void>((resolve) => {
      notifyClosed = resolve;
    });

    const heartbeat = setInterval(() => {
      if (!closed) res.write(": hb\n\n");
    }, sseHeartbeatMs);

    const iterator = engine.subscribe(userId, sinceId)[Symbol.asyncIterator]();

    const onClose = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      notifyClosed?.();
      // Best-effort: unsubscribe the generator's event-bus listener
      // (architecture §11) — takes effect immediately if the generator is
      // paused at a yield, or as soon as its next event arrives otherwise.
      void iterator.return?.(undefined).catch(() => {});
    };
    request.raw.on("close", onClose);

    try {
      for (;;) {
        if (closed) break;

        type StepResult = { kind: "value"; value: { id: number; event: Record<string, unknown> }; done?: boolean } | { kind: "done" } | { kind: "error"; err: unknown } | { kind: "closed" };

        const step: StepResult = await Promise.race([
          iterator.next().then(
            (r): StepResult => (r.done ? { kind: "done" } : { kind: "value", value: r.value }),
            (err: unknown): StepResult => ({ kind: "error", err })
          ),
          closedPromise.then((): StepResult => ({ kind: "closed" })),
        ]);

        if (step.kind === "closed" || step.kind === "done") break;
        if (step.kind === "error") throw step.err;
        if (closed) break;

        res.write(`id: ${step.value.id}\n`);
        res.write(`data: ${JSON.stringify(step.value.event)}\n\n`);
      }
    } catch {
      // Connection dropped mid-write, or the subscription errored — nothing
      // more can be conveyed once the stream is open (api-contract §3).
    } finally {
      request.raw.off("close", onClose);
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  });
}
