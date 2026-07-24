/**
 * `GET /health` — docs/api-contract.md §6.10. Unauthenticated liveness
 * probe; the only route that never calls `authenticate`.
 */
import type { FastifyInstance } from "fastify";

export async function registerHealthRoute(app: FastifyInstance): Promise<void> {
  app.get("/health", async (_request, reply) => {
    reply.code(200).send({ status: "ok" });
  });
}
