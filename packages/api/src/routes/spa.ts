/**
 * Serving the built dashboard from the api process (docs/api-contract.md §9,
 * build-plan Phase 5: "production build served by the API package").
 *
 * The route-ownership boundary is fixed and this module must not blur it:
 *
 *   - The API owns exactly `/tasks` and everything under it, `/events`, and
 *     `/health`. Those paths behave as documented and NEVER serve HTML — a
 *     scripted client that mistypes a path must get a JSON error envelope, not
 *     an index.html with a 200, which would read as success.
 *   - Every other GET serves the SPA: a built asset when the path matches one,
 *     otherwise `index.html`, so client-side routing resolves `/task/:id`.
 *   - Non-GET requests outside the API paths are 404.
 *
 * `@fastify/static` is registered with `serve: false`, so it registers NO
 * routes and only decorates `reply.sendFile`. Everything reaches the SPA
 * through the single not-found handler in `errors.ts`, which means there is
 * exactly one place where the boundary is decided and no possibility of a
 * static wildcard shadowing an API route.
 */
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";

import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface SpaRouteOptions {
  /** Absolute path to the built SPA (packages/web/dist). */
  root: string;
}

/** Handles an unmatched request; returns false if it declined to. */
export type SpaFallback = (request: FastifyRequest, reply: FastifyReply) => boolean;

/** The prefixes the API owns outright. Anything matching these must never fall
 * through to the SPA, even when no API route matched the exact path. */
const API_PREFIXES = ["/tasks", "/events", "/health"];

export function isApiPath(url: string): boolean {
  const path = url.split("?")[0] ?? "";
  return API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Registers the static decorator and returns the fallback to hand to
 * `registerErrorHandling`. Returns `null` when there is no build to serve —
 * the case in development, where Vite serves the SPA and proxies these paths
 * back here. A missing build is not worth crashing the API over; the API is
 * useful on its own.
 */
export async function registerSpaAssets(
  app: FastifyInstance,
  opts: SpaRouteOptions
): Promise<SpaFallback | null> {
  const indexPath = join(opts.root, "index.html");
  if (!existsSync(indexPath)) return null;

  await app.register(fastifyStatic, {
    root: opts.root,
    // No routes: this only decorates reply.sendFile. See the module comment.
    serve: false,
  });

  return (request, reply) => {
    // The API's paths keep their documented behaviour, envelope and all.
    if (isApiPath(request.url)) return false;
    // Outside the API, only GET has an SPA to serve.
    if (request.method !== "GET") return false;

    const requested = (request.url.split("?")[0] ?? "/").replace(/^\/+/, "");
    // `normalize` collapses any `..` before it can escape the build directory.
    const relative = normalize(requested);
    const escapes = relative.startsWith("..");

    if (!escapes && relative !== "" && existsSync(join(opts.root, relative))) {
      // Built asset filenames carry a content hash, so they are immutable.
      void reply.header("cache-control", "public, max-age=31536000, immutable").sendFile(relative);
      return true;
    }

    // A path whose last segment has an extension is an asset request, and a
    // missing asset must 404. Falling back to index.html here would hand a
    // stale client HTML in place of the hashed bundle it asked for, which the
    // browser then tries to parse as JavaScript — a far more confusing failure
    // than a plain 404. Client routes (`/`, `/submit`, `/task/:id`) have no
    // extension, so they are unaffected.
    const lastSegment = relative.split(/[\\/]/).pop() ?? "";
    if (escapes || lastSegment.includes(".")) return false;

    // Anything else is a client route: hand back the shell. index.html names
    // the hashed bundles, so caching it would pin clients to a stale build.
    void reply.type("text/html").header("cache-control", "no-cache").sendFile("index.html");
    return true;
  };
}
