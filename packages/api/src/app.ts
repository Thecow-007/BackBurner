/**
 * Fastify instance assembly — docs/api-contract.md §1 (CORS), §3 (error
 * envelope), §9 (route ownership). `server.ts` is the only caller.
 */
import cors from "@fastify/cors";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import type { Engine } from "@backburner/engine";

import { registerErrorHandling } from "./errors.js";
import { registerEventsRoute } from "./routes/events.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerTaskRoutes } from "./routes/tasks.js";

export interface BuildAppOptions {
  engine: Engine;
  pool: Pool;
  sseHeartbeatMs: number;
  /** Lanes backed by the mock worker — see routes/tasks.ts. */
  mockWorkerLanes: ReadonlySet<string>;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Permissive CORS (api-contract §1): the API is bearer-authenticated and
  // external agents are first-class clients, so any origin may call it.
  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    exposedHeaders: ["Authorization"],
  });

  // Registered before routes so it's active for every request, including
  // validation failures raised while matching/parsing a route.
  registerErrorHandling(app);

  await registerHealthRoute(app);
  await registerTaskRoutes(app, { engine: opts.engine, pool: opts.pool, mockWorkerLanes: opts.mockWorkerLanes });
  await registerEventsRoute(app, { engine: opts.engine, pool: opts.pool, sseHeartbeatMs: opts.sseHeartbeatMs });

  return app;
}
