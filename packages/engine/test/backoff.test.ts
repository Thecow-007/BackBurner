import { describe, expect, it } from "vitest";
import { computeBackoffMs, DEFAULT_BACKOFF_BASE_MS, resolveBackoffConfig } from "../src/backoff.js";

describe("backoff (pure) — test-plan.md §6", () => {
  it("nominal delays: base·2^(attempts-1) when rng()=0.5 (jitter factor 1.0)", () => {
    const config = resolveBackoffConfig({ baseMs: 100, rng: () => 0.5 });
    expect(computeBackoffMs(1, config)).toBeCloseTo(100, 9);
    expect(computeBackoffMs(2, config)).toBeCloseTo(200, 9);
    expect(computeBackoffMs(3, config)).toBeCloseTo(400, 9);
  });

  it("jitter is bounded within ±25% across the RNG's extremes", () => {
    const low = resolveBackoffConfig({ baseMs: 1000, rng: () => 0 });
    const high = resolveBackoffConfig({ baseMs: 1000, rng: () => 1 });

    // rng() -> 0 yields the 0.75 floor; rng() -> 1 yields the 1.25 ceiling.
    expect(computeBackoffMs(1, low)).toBeCloseTo(750, 9);
    expect(computeBackoffMs(1, high)).toBeCloseTo(1250, 9);
    expect(computeBackoffMs(4, low)).toBeCloseTo(1000 * 2 ** 3 * 0.75, 6);
    expect(computeBackoffMs(4, high)).toBeCloseTo(1000 * 2 ** 3 * 1.25, 6);
  });

  it("defaults baseMs to 2000 when unconfigured", () => {
    const config = resolveBackoffConfig();
    expect(config.baseMs).toBe(DEFAULT_BACKOFF_BASE_MS);
    expect(DEFAULT_BACKOFF_BASE_MS).toBe(2000);

    const configWithRngOnly = resolveBackoffConfig({ rng: () => 0.5 });
    expect(configWithRngOnly.baseMs).toBe(2000);
    expect(computeBackoffMs(1, configWithRngOnly)).toBeCloseTo(2000, 9);
  });

  it("uses Math.random by default when no rng is injected", () => {
    const config = resolveBackoffConfig({ baseMs: 100 });
    const delay = computeBackoffMs(1, config);
    expect(delay).toBeGreaterThanOrEqual(75);
    expect(delay).toBeLessThanOrEqual(125);
  });

  it("property: for attempts 1-10, delay is always within [0.75, 1.25] * base * 2^(n-1)", () => {
    const base = 137; // an odd base to avoid accidental power-of-two coincidences
    const rngValues = [0, 0.01, 0.25, 0.5, 0.5, 0.75, 0.999, 1];
    for (const rngValue of rngValues) {
      const config = resolveBackoffConfig({ baseMs: base, rng: () => rngValue });
      for (let attempts = 1; attempts <= 10; attempts++) {
        const nominal = base * 2 ** (attempts - 1);
        const delay = computeBackoffMs(attempts, config);
        expect(delay).toBeGreaterThanOrEqual(nominal * 0.75 - 1e-9);
        expect(delay).toBeLessThanOrEqual(nominal * 1.25 + 1e-9);
      }
    }
  });
});
