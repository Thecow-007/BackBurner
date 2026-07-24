/**
 * Timing constants for the e2e harness (test-plan.md §3.6).
 *
 * This is the *only* file allowed to contain a bare timing literal (other
 * than the values named here). Every bound used by a criterion or
 * supplemental test — anywhere in `packages/e2e/test/` — must reference one
 * of these exports by name, so a change to CI slack or a spec bound is a
 * one-line, reviewable diff instead of a scavenger hunt.
 *
 * Rules (test-plan.md §3.6, §9):
 *   1. Never sleep blind. All waiting is `waitFor`/`waitForCount` with an
 *      explicit timeout; the sole exception is the sentinel-bounded
 *      `settleMs` tail inside `EventCapture.assertNever`.
 *   2. Upper bounds are generous (CI machines are slow); lower bounds are
 *      rare and, where used, carry a 10% tolerance.
 *   3. `T_HTTP` is the spec's own bound and is never widened.
 */

/** spawn → `BACKBURNER_READY` line (test-plan.md §3.1). */
export const T_BOOT = 15_000;

/**
 * The spec's own "well under one second" enqueue bound (criterion 1: POST
 * /tasks must return long before a 10s job finishes). This is a **spec
 * law**, not a CI-slack tunable — it is always measured against a warmed
 * connection pool (test-plan.md §4.1's unmeasured warm-up request), so the
 * bound constrains request handling, never process cold-start.
 */
export const T_HTTP = 1_000;

/** Any promptly-caused event: `accepted`, `running` after a free slot, `cancelled`. */
export const T_EVENT = 2_500;

/** `ready`/`failed` after a job of duration `d` (ms) starts. */
export function T_JOB(d: number): number {
  return d + 5_000;
}

/** Tail window kept open after a sentinel event in negative assertions. */
export const T_SETTLE = 5_000;

/** SIGTERM → SIGKILL fallback bound in `stopServer` (test-plan.md §3.1). */
export const T_STOP = 3_000;

/** A full 3-attempt failure chain lands in `failed` (test-plan.md §4.5). */
export const T_RETRY_CHAIN = 10_000;

/**
 * Criterion 08's premise check (test-plan.md §4.8): the three `ready`
 * arrivals must span less than this for the spec's "all finish within about
 * a second of each other" scenario to have actually been exercised. §3.6's
 * table does not name it, but §3.6 requires every bound in §4 to live here
 * by name — so it does.
 */
export const T_COMPLETION_SPAN = 2_000;

/** Completion bound for `n` dispatch waves of duration-`d` (ms) jobs (§4.7, §4.9). */
export function T_WAVES(n: number, d: number): number {
  return n * d + 10_000;
}
