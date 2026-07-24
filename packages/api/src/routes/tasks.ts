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
import type { Engine, ListFilters } from "@backburner/engine";

import { authenticate } from "../auth.js";
import { listQuerySchema, parseSubmitBody } from "../schemas.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TaskRouteOptions {
  engine: Engine;
  pool: Pool;
  /** Lanes backed by the mock worker — `normalizeMockParams` runs only for
   * these (CLAUDE.md, api-contract §1). Any other submitted lane is simply
   * unregistered with the engine and raises `UnknownLaneError`. */
  mockWorkerLanes: ReadonlySet<string>;
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
}

export async function registerTaskRoutes(app: FastifyInstance, opts: TaskRouteOptions): Promise<void> {
  const { engine, pool, mockWorkerLanes } = opts;

  // POST /tasks — api-contract §6.1.
  app.post("/tasks", async (request, reply) => {
    const userId = await authenticate(request, pool);
    const parsed = parseSubmitBody(request.body);

    const params = mockWorkerLanes.has(parsed.lane)
      ? normalizeMockParams(parsed.params)
      : parsed.params;

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

    const result = await engine.list(userId, filters);
    reply.code(200).send(result);
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
