/**
 * The mock worker — docs/architecture.md §8 commentary,
 * docs/api-contract.md §1 "Registered lanes", CLAUDE.md item 14.
 *
 * Design note (flagged in the final report): the engine's `submit()` is
 * lane-agnostic by architecture mandate ("the engine contains zero
 * lane-specific logic", architecture §8). The spec's "omitted duration_ms
 * is chosen once, at submit time, and written into stored params" is
 * therefore implemented as `normalizeMockParams` here — a pure, exported
 * helper the API composes *before* calling `engine.submit()` for lanes it
 * wires to this worker. Because `submit()` persists whatever params object
 * it is given verbatim and never rewrites `params` on any later
 * transition, a value resolved by the API pre-submit is exactly as durable
 * and retry-deterministic as one resolved inside the engine would be —
 * without teaching engine-core anything about `duration_ms`/`fail`/
 * `fail_permanent`. This module is also usable directly against
 * `createEngine`'s generic `submit()` for engine-level testing.
 */
import { ValidationError } from "./errors.js";
import type { Job, Worker, WorkerContext, WorkerResult } from "./types.js";

const MIN_DURATION_MS = 1;
const MAX_DURATION_MS = 600000;
const RANDOM_MIN_MS = 3000;
const RANDOM_MAX_MS = 15000;

export function randomDurationMs(rng: () => number = Math.random): number {
  return Math.floor(rng() * (RANDOM_MAX_MS - RANDOM_MIN_MS + 1)) + RANDOM_MIN_MS;
}

/**
 * Validates `duration_ms`/`fail`/`fail_permanent` if present, and fills a
 * random `duration_ms` (chosen once, via `rng`) when omitted. Extra keys
 * pass through untouched. Never mutates the input object. Throws the
 * engine's `ValidationError` (-> 400 invalid_params at the API) on a bad
 * shape.
 */
export function normalizeMockParams(
  params: Record<string, unknown>,
  rng: () => number = Math.random
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params };

  if (out.duration_ms === undefined) {
    out.duration_ms = randomDurationMs(rng);
  } else {
    const d = out.duration_ms;
    if (typeof d !== "number" || !Number.isInteger(d) || d < MIN_DURATION_MS || d > MAX_DURATION_MS) {
      throw new ValidationError(
        `params.duration_ms must be an integer between ${MIN_DURATION_MS} and ${MAX_DURATION_MS}`
      );
    }
  }

  if (out.fail !== undefined && typeof out.fail !== "boolean") {
    throw new ValidationError("params.fail must be a boolean");
  }
  if (out.fail_permanent !== undefined && typeof out.fail_permanent !== "boolean") {
    throw new ValidationError("params.fail_permanent must be a boolean");
  }

  return out;
}

function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    signal.addEventListener("abort", onAbort);
  });
}

/**
 * The mock worker backing the `scrape` and `report` lanes. Races its sleep
 * against `ctx.signal` so cancellation stops it promptly. If
 * `duration_ms` was somehow never normalized before submit (bypassing
 * `normalizeMockParams`), it falls back to a fresh random duration here —
 * a defensive fallback outside the primary, deterministic-retry path.
 */
export function createMockWorker(): Worker {
  return async (job: Job, ctx: WorkerContext): Promise<WorkerResult> => {
    const raw = job.params.duration_ms;
    const durationMs = typeof raw === "number" && Number.isFinite(raw) ? raw : randomDurationMs();

    await sleep(durationMs, ctx.signal);

    if (job.params.fail_permanent === true) {
      return {
        status: "failed",
        error: {
          reason: "mock permanent failure requested via params.fail_permanent",
          retryable: false,
        },
      };
    }

    if (job.params.fail === true) {
      return {
        status: "failed",
        error: { reason: "mock failure requested via params.fail", retryable: true },
      };
    }

    return {
      status: "ready",
      result: { message: `${job.handle} completed`, slept_ms: durationMs },
    };
  };
}
