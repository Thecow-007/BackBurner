import { afterEach, describe, expect, it, vi } from "vitest";
import { createDispatcher, type ClaimOutcome, type Dispatcher } from "../src/dispatch.js";

describe("dispatch single-flight + timer arming (pure) — test-plan.md §6", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("N concurrent trigger() calls never let claim rounds interleave", async () => {
    let inFlight = 0;
    let interleaved = false;
    let calls = 0;

    const claim = vi.fn(async (): Promise<ClaimOutcome> => {
      calls++;
      if (inFlight > 0) interleaved = true;
      inFlight++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return calls < 20 ? "claimed" : "empty";
    });
    const armWakeup = vi.fn(async (): Promise<number | null> => null);

    const dispatcher = createDispatcher({ claim, armWakeup });

    const triggers = Array.from({ length: 10 }, () => dispatcher.trigger());
    await Promise.all(triggers);

    expect(interleaved).toBe(false);
    expect(calls).toBeGreaterThanOrEqual(20);
  });

  it("a trigger() call arriving mid-run causes exactly one trailing re-run, not N", async () => {
    let claimCalls = 0;
    // eslint-disable-next-line prefer-const
    let dispatcher: Dispatcher;

    const claim = vi.fn(async (): Promise<ClaimOutcome> => {
      claimCalls++;
      if (claimCalls === 1) {
        // Simulate five separate callers triggering dispatch while this
        // first pass is still in flight.
        for (let i = 0; i < 5; i++) void dispatcher.trigger();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return "empty";
    });
    const armWakeup = vi.fn(async (): Promise<number | null> => null);

    dispatcher = createDispatcher({ claim, armWakeup });

    await dispatcher.trigger();

    // Pass 1 (1 claim call, ends "empty") + exactly one trailing pass
    // caused by the dirty flag (1 more claim call) = 2 total, never 6.
    expect(claimCalls).toBe(2);
    expect(armWakeup).toHaveBeenCalledTimes(2);
  });

  it("with fake timers, a future run_after schedules exactly one wake-up at the earliest due time", async () => {
    vi.useFakeTimers();

    let armCalls = 0;
    const claim = vi.fn(async (): Promise<ClaimOutcome> => "empty");
    const armWakeup = vi.fn(async (): Promise<number | null> => {
      armCalls++;
      return armCalls === 1 ? 500 : null;
    });

    const dispatcher = createDispatcher({ claim, armWakeup });

    await dispatcher.trigger();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(armWakeup).toHaveBeenCalledTimes(1);

    // Not yet due.
    await vi.advanceTimersByTimeAsync(499);
    expect(claim).toHaveBeenCalledTimes(1);

    // Crossing the threshold fires exactly one wake-up, which runs exactly
    // one more pass.
    await vi.advanceTimersByTimeAsync(1);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(armWakeup).toHaveBeenCalledTimes(2);

    // Second arm call returned null -> no further timer; nothing else fires.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it("re-arms only once even if multiple passes each report a future delay (replaces the previous timer)", async () => {
    vi.useFakeTimers();

    const claim = vi.fn(async (): Promise<ClaimOutcome> => "empty");
    const armWakeup = vi.fn(async (): Promise<number | null> => 1000);

    const dispatcher = createDispatcher({ claim, armWakeup });
    await dispatcher.trigger();
    expect(claim).toHaveBeenCalledTimes(1);

    // A fresh external trigger before the timer is due should still result
    // in a single re-armed timer (the stale one is cleared), not two firings.
    await vi.advanceTimersByTimeAsync(200);
    await dispatcher.trigger();
    expect(claim).toHaveBeenCalledTimes(2);

    // Only ~1000ms after the second trigger should the (re-armed) timer fire.
    await vi.advanceTimersByTimeAsync(799);
    expect(claim).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(201);
    expect(claim).toHaveBeenCalledTimes(3);
  });
});
