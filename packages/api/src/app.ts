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
import { registerSpaAssets } from "./routes/spa.js";
import { registerTaskRoutes } from "./routes/tasks.js";

export interface BuildAppOptions {
  engine: Engine;
  pool: Pool;
  sseHeartbeatMs: number;
  /** Lanes backed by the mock worker — see routes/tasks.ts. */
  mockWorkerLanes: ReadonlySet<string>;
  /** Absolute path to the built SPA. Omitted (or missing on disk) means the
   * dashboard is not served from here — the case in dev, where Vite serves it
   * and proxies the API paths back. */
  spaRoot?: string;
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

  // The SPA decorator first (it registers no routes — see routes/spa.ts), so
  // the not-found handler below can hand unmatched GETs to the dashboard.
  // Returns null when there is no build, which is the development case.
  const spaFallback =
    opts.spaRoot === undefined ? null : await registerSpaAssets(app, { root: opts.spaRoot });

  // Registered before routes so it's active for every request, including
  // validation failures raised while matching/parsing a route.
  registerErrorHandling(app, { onNotFound: spaFallback ?? undefined });

  await registerHealthRoute(app);
  await registerTaskRoutes(app, { engine: opts.engine, pool: opts.pool, mockWorkerLanes: opts.mockWorkerLanes });
  await registerEventsRoute(app, { engine: opts.engine, pool: opts.pool, sseHeartbeatMs: opts.sseHeartbeatMs });

  return app;
}
