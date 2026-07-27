/**
 * `/tasks*` routes — docs/api-contract.md §6.1-6.8. Thin transport: resolve
 * auth to a `userId`, call the engine's public surface, map the result or
 * error. No SQL against `tasks`/`task_transitions` lives here or anywhere
 * else in this package (docs/architecture.md §2 — the engine owns those
 * tables exclusively).
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { ValidationError, normalizeMockParams } from "@backburner/engine";
import type { DurationRange, Engine, ListFilters, TaskCounts } from "@backburner/engine";

import { authenticate } from "../auth.js";
import { listQuerySchema, parseSubmitBody } from "../schemas.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TaskRouteOptions {
  engine: Engine;
  pool: Pool;
  /** Lanes backed by the mock worker, mapped to the range an omitted
   * `params.duration_ms` is drawn from — `normalizeMockParams` runs only for
   * these (CLAUDE.md, api-contract §1). Any other submitted lane is simply
   * unregistered with the engine and raises `UnknownLaneError`. Insertion
   * order is lane registration order, which `lane_defaults` preserves. */
  mockWorkerLanes: ReadonlyMap<string, DurationRange>;
}

/** `counts.lane_defaults` — [EXTENSION], api-contract §6.2. Mock-worker
 * metadata, so it is assembled HERE and not by `engine.counts()`: the engine
 * is lane-agnostic and knows nothing about `duration_ms` (ADR 0017, 0021). */
interface LaneDefaults {
  [lane: string]: { duration_ms: { min: number; max: number } };
}

interface CountsWithLaneDefaults extends TaskCounts {
  lane_defaults: LaneDefaults;
}

function requireUuid(id: string): void {
  if (!UUID_RE.test(id)) {
    throw new ValidationError(`"${id}" is not a syntactically valid UUID`);
  }
}

interface ListQuery {
  status?: string;
  lane?: string;
  from?: string;
  to?: string;
  sort?: string;
  limit?: number;
  cursor?: string;
  uncollected?: string;
  q?: string;
}

export async function registerTaskRoutes(app: FastifyInstance, opts: TaskRouteOptions): Promise<void> {
  const { engine, pool, mockWorkerLanes } = opts;

  // Computed once at registration: the registry is static for a process's
  // lifetime, and the object is frozen so no handler can mutate the shared
  // instance it ships on every list response.
  const laneDefaults: LaneDefaults = {};
  for (const [lane, range] of mockWorkerLanes) {
    laneDefaults[lane] = { duration_ms: { min: range.min, max: range.max } };
  }
  Object.freeze(laneDefaults);

  // POST /tasks — api-contract §6.1.
  app.post("/tasks", async (request, reply) => {
    const userId = await authenticate(request, pool);
    const parsed = parseSubmitBody(request.body);

    const range = mockWorkerLanes.get(parsed.lane);
    const params =
      range !== undefined ? normalizeMockParams(parsed.params, Math.random, range) : parsed.params;

    const task = await engine.submit(userId, parsed.lane, params, {
      maxAttempts: parsed.maxAttempts,
    });
    reply.code(201).send(task);
  });

  // GET /tasks — api-contract §6.2, §7.
  app.get("/tasks", { schema: { querystring: listQuerySchema } }, async (request, reply) => {
    const userId = await authenticate(request, pool);
    const query = request.query as ListQuery;

    const filters: ListFilters = {};
    if (query.status !== undefined) filters.status = query.status;
    if (query.lane !== undefined) filters.lane = query.lane;
    if (query.from !== undefined) filters.from = query.from;
    if (query.to !== undefined) filters.to = query.to;
    if (query.sort !== undefined) filters.sort = query.sort;
    if (query.limit !== undefined) filters.limit = query.limit;
    if (query.cursor !== undefined) filters.cursor = query.cursor;
    if (query.uncollected !== undefined) filters.uncollected = query.uncollected;
    if (query.q !== undefined) filters.q = query.q;

    // `counts` is additive on the list envelope (api-contract §6.2,
    // [EXTENSION]) and is computed on every 200, cursor pages included —
    // never cached, never omitted. The engine owns the SQL; the same parsed
    // filters drive both calls, so the numbers can never describe a
    // different filter than the page they ship with.
    const result = await engine.list(userId, filters);
    const engineCounts = await engine.counts(userId, filters);
    // `lane_defaults` is the one count-object field the engine does not
    // produce: it describes the MOCK WORKER's per-lane omitted-duration
    // ranges, which is API-layer knowledge (ADR 0017, 0021). It is added on
    // serialisation so the submit form can state a lane's actual range
    // instead of hard-coding one it cannot source (frontend-brief §6.5).
    const counts: CountsWithLaneDefaults = { ...engineCounts, lane_defaults: laneDefaults };
    reply.code(200).send({ ...result, counts });
  });

  // GET /tasks/id/:id — api-contract §6.7 (registered before /tasks/:handle
  // so the literal "id" segment is unambiguous; Fastify's router already
  // prefers the static match regardless of registration order).
  app.get("/tasks/id/:id", async (request, reply) => {
    const userId = await authenticate(request, pool);
    const { id } = request.params as { id: string };
    requireUuid(id);
    const task = await engine.get(userId, { id });
    reply.code(200).send(task);
  });

  // GET /tasks/id/:id/history — api-contract §6.8.
  app.get("/tasks/id/:id/history", async (request, reply) => {
    const userId = await authenticate(request, pool);
    const { id } = request.params as { id: string };
    requireUuid(id);
    const result = await engine.history(userId, id);
    reply.code(200).send(result);
  });

  // GET /tasks/:handle — api-contract §6.3.
  app.get("/tasks/:handle", async (request, reply) => {
    const userId = await authenticate(request, pool);
    const { handle } = request.params as { handle: string };
    const task = await engine.get(userId, { handle });
    reply.code(200).send(task);
  });

  // GET /tasks/:handle/result — api-contract §6.4. The one GET with a side
  // effect: never call `engine.collect` from anywhere else in this package.
  app.get("/tasks/:handle/result", async (request, reply) => {
    const userId = await authenticate(request, pool);
    const { handle } = request.params as { handle: string };
    const task = await engine.collect(userId, handle);
    reply.code(200).send(task);
  });

  // POST /tasks/:handle/cancel — api-contract §6.5.
  app.post("/tasks/:handle/cancel", async (request, reply) => {
    const userId = await authenticate(request, pool);
    const { handle } = request.params as { handle: string };
    const task = await engine.cancel(userId, handle);
    reply.code(200).send(task);
  });

  // POST /tasks/:handle/retry — api-contract §6.6.
  app.post("/tasks/:handle/retry", async (request, reply) => {
    const userId = await authenticate(request, pool);
    const { handle } = request.params as { handle: string };
    const task = await engine.retry(userId, handle);
    reply.code(200).send(task);
  });
}
