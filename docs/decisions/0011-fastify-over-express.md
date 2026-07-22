# 0011. Fastify over Express

Status: Accepted — 2026-07-21

## Context

The API layer is deliberately thin — auth, validation, serialization, SSE — but each of those has teeth. Every route except `/health` requires bearer auth with strict per-user scoping. Input validation is contract behavior, not hygiene: unknown lane and invalid params must produce consistent `400`s with a fixed error envelope. `/events` needs a long-lived raw response stream with heartbeats. All of it in strict TypeScript on Node 22.

## Decision

Fastify. Routes declare JSON-schema for bodies, query strings, and params, so malformed input is rejected before a handler runs and the schemas double as machine-readable contract documentation. Auth and CORS (`@fastify/cors`) are encapsulated plugins applied to the API scope; the SPA-serving scope in production sits outside them. SSE writes go through the raw reply, with the route opting out of Fastify's normal serialization lifecycle.

## Alternatives considered

- **Express.** The default answer and perfectly capable of this workload. But validation is bring-your-own (a schema library plus per-route glue), its types remain middleware-era retrofits, and error-envelope consistency depends on discipline rather than a first-class error hook. Fastify provides the three things this API actually needs as built-ins.
- **Hono.** Modern, fast, portable across runtimes, and a genuinely credible pick. Chosen against on maturity of the plugin ecosystem for this exact shape of app — encapsulated auth scopes, JSON-schema validation, static serving — where Fastify's answers are long-settled. On a one-week timeline, settled beats novel.
- **NestJS.** Decorators, DI containers, and module ceremony bury the one boundary this project is graded on keeping visible: API routes calling an engine's public surface. The framework's value scales with team size; here it only adds indirection.
- **Bare `node:http`.** SSE is actually pleasant at this level, but routing, auth, validation, and error consistency all become hand-rolled code that a framework provides tested.

## Consequences

- Validation failures are consistent by construction — one error hook maps schema violations and typed engine errors onto the single documented envelope, and no handler executes on bad input.
- Auth-as-plugin makes the security boundary auditable in one place: everything under the API scope demands a key; `/health` and static assets are the only exceptions, both explicit.
- The SSE route is the one place that steps outside the framework's reply lifecycle; the hand-rolled streaming code is contained there rather than smeared across the API.
- Route schemas give the README's endpoint documentation a source of truth to be checked against, rather than prose that drifts.
