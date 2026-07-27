/**
 * The submit form's **Random** outcome is rolled in the browser, not on the
 * server (ADR 0028): the nine criteria tests submit with `duration_ms` only and
 * require deterministic success, so the engine's no-outcome-param path must stay
 * a guaranteed success and the dice have to live here.
 *
 * A dice roll is exactly the kind of thing that looks right and is not, so the
 * RNG is an injected seam and these tests pin it. The `fail_times` bound is
 * pinned alongside it, because a "flaky" task that cannot recover is not flaky —
 * it is just a failure with extra steps.
 */
import { describe, expect, it } from "vitest";

import {
  clampFailTimes,
  flakyBound,
  formatDurationRange,
  OUTCOME_WEIGHTS,
  rollOutcome,
  type ResolvedOutcome,
} from "../src/screens/Submit.js";

/** A seam that returns exactly what a test tells it to, one call at a time. */
function pinned(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

describe("OUTCOME_WEIGHTS", () => {
  it("sums to exactly 1, so no roll can fall off the end of the table", () => {
    const total = OUTCOME_WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("is the mix the owner asked for: mostly success, a real minority of failures", () => {
    expect(OUTCOME_WEIGHTS).toEqual([
      ["succeed", 0.65],
      ["flaky", 0.15],
      ["fail", 0.13],
      ["fail_permanent", 0.07],
    ]);
  });
});

describe("rollOutcome — pinned RNG", () => {
  it("maps each band of the unit interval to the documented outcome", () => {
    const cases: ReadonlyArray<readonly [number, ResolvedOutcome]> = [
      [0, "succeed"],
      [0.3, "succeed"],
      [0.649999, "succeed"],
      [0.65, "flaky"],
      [0.7, "flaky"],
      [0.799999, "flaky"],
      [0.8, "fail"],
      [0.92, "fail"],
      [0.929999, "fail"],
      [0.93, "fail_permanent"],
      [0.999999, "fail_permanent"],
    ];
    for (const [roll, expected] of cases) {
      expect(rollOutcome(pinned(roll), true), `roll ${roll}`).toBe(expected);
    }
  });

  it("produces every outcome across a sweep, so the mix is genuinely varied", () => {
    const seen = new Set<ResolvedOutcome>();
    for (let i = 0; i < 100; i += 1) seen.add(rollOutcome(pinned(i / 100), true));
    expect([...seen].sort()).toEqual(["fail", "fail_permanent", "flaky", "succeed"]);
  });

  it("falls back to succeed rather than throwing if the seam misbehaves", () => {
    expect(rollOutcome(pinned(1), true)).toBe("succeed");
    expect(rollOutcome(pinned(42), true)).toBe("succeed");
  });

  it("never rolls flaky when the attempt budget cannot support it", () => {
    // The flaky slice folds into succeed, rather than being redistributed
    // across the failures — a budget of 1 is already the harshest setting on
    // the form and must not silently make failure more likely as well.
    expect(rollOutcome(pinned(0.7), false)).toBe("succeed");
    expect(rollOutcome(pinned(0.85), false)).toBe("fail");
    expect(rollOutcome(pinned(0.95), false)).toBe("fail_permanent");
  });
});

describe("flakyBound — fail_times must stay BELOW the attempt budget", () => {
  it("clamps to 1 when the budget is left blank", () => {
    // Blank means the engine applies the lane's configured default, which no
    // endpoint reports. 1 is the only value that recovers under every budget
    // above 1, so it is the only value the SPA may assume.
    expect(flakyBound(null)).toBe(1);
  });

  it("allows 1…N−1 for an explicit budget of N", () => {
    expect(flakyBound(2)).toBe(1);
    expect(flakyBound(3)).toBe(2);
    expect(flakyBound(5)).toBe(4);
  });

  it("is 0 at a budget of 1 — flaky is impossible and the option is retired", () => {
    expect(flakyBound(1)).toBe(0);
  });

  it("never exceeds the wire's own 1–9 range", () => {
    // max_attempts caps at 10, so N−1 lands exactly on the fail_times ceiling.
    expect(flakyBound(10)).toBe(9);
    expect(flakyBound(20)).toBe(9);
  });
});

describe("clampFailTimes", () => {
  it("holds a request inside the bound", () => {
    expect(clampFailTimes(1, 3)).toBe(1);
    expect(clampFailTimes(2, 3)).toBe(2);
    expect(clampFailTimes(9, 3)).toBe(2); // would exhaust the budget → clamped
    expect(clampFailTimes(0, 3)).toBe(1);
    expect(clampFailTimes(-4, 3)).toBe(1);
  });

  it("clamps to 1 with a blank budget", () => {
    expect(clampFailTimes(2, null)).toBe(1);
    expect(clampFailTimes(1, null)).toBe(1);
  });

  it("returns 0 when flaky is impossible, which means `do not send the param`", () => {
    expect(clampFailTimes(1, 1)).toBe(0);
  });

  it("never produces a fail_times at or above the budget it was given", () => {
    for (let budget = 2; budget <= 10; budget += 1) {
      for (let requested = 1; requested <= 12; requested += 1) {
        const value = clampFailTimes(requested, budget);
        expect(value, `budget ${budget}, requested ${requested}`).toBeLessThan(budget);
        expect(value).toBeGreaterThanOrEqual(1);
        expect(value).toBeLessThanOrEqual(9);
      }
    }
  });
});

describe("formatDurationRange — sourced numbers only", () => {
  it("renders the lane ranges the API reports", () => {
    expect(formatDurationRange(3000, 15000)).toBe("3–15 s");
    expect(formatDurationRange(20000, 90000)).toBe("20–90 s");
  });

  it("keeps a fractional second rather than rounding it away", () => {
    expect(formatDurationRange(500, 1500)).toBe("0.5–1.5 s");
  });
});
