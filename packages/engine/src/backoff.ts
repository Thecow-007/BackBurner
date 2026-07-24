/**
 * Retry backoff — docs/architecture.md §9, test-plan.md §6.
 * delay_ms = baseMs * 2^(attempts-1) * (0.75 + 0.5*rng()), rng in [0,1).
 * Kept pure and RNG-injectable so it is deterministically unit-testable.
 */
import type { BackoffOptions } from "./types.js";

export const DEFAULT_BACKOFF_BASE_MS = 2000;

export interface BackoffConfig {
  baseMs: number;
  rng: () => number;
}

export function resolveBackoffConfig(opts?: BackoffOptions): BackoffConfig {
  return {
    baseMs: opts?.baseMs ?? DEFAULT_BACKOFF_BASE_MS,
    rng: opts?.rng ?? Math.random,
  };
}

/** attempts is the number of attempts already consumed (>= 1). */
export function computeBackoffMs(attempts: number, config: BackoffConfig): number {
  const jitter = 0.75 + 0.5 * config.rng();
  return config.baseMs * 2 ** (attempts - 1) * jitter;
}
