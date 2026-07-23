/**
 * @backburner/api — Fastify REST + SSE server (Phase 0 stub).
 *
 * Deliberately NOT a server entrypoint. Phase 1's criteria tests must fail
 * because no implementation exists (docs/build-plan.md, TDD Gate A) — do not
 * add `src/server.ts` or anything that would produce `dist/server.js` here
 * before Gate A is committed.
 *
 * Phase 3 adds routes, auth, and the SSE transport wired to the engine's
 * public surface only (docs/api-contract.md, docs/architecture.md §2).
 */
import { ENGINE_PACKAGE_NAME } from "@backburner/engine";

export const API_PACKAGE_NAME = "@backburner/api";

/** Proves the workspace dependency on the engine's public surface resolves. */
export const DEPENDS_ON_ENGINE = ENGINE_PACKAGE_NAME;
