/**
 * @backburner/e2e — black-box test harness (test-plan.md §3).
 *
 * Spawns the real API server as a child process against a dedicated test
 * database, drives it via `fetch` and an `EventSource`-backed SSE client,
 * and exposes timing constants and wait helpers so the criteria and
 * supplemental suites never sleep blind. This package never imports engine
 * or api code and asserts only over HTTP/SSE — see CLAUDE.md's package
 * boundaries and test-plan.md §1 ("black-box over HTTP").
 */

export * from "./timing.js";
export * from "./users.js";
export * from "./db.js";
export * from "./server.js";
export * from "./api.js";
export * from "./events.js";
export * from "./settle.js";
export * from "./seed-cli.js";
