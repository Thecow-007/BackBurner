/**
 * Pure single-flight dispatch loop + skew-safe timer arming —
 * docs/architecture.md §8. Deliberately has no SQL/pg import so
 * dispatch-single-flight.test.ts can exercise it with an injected claim
 * function and vitest's fake timers (test-plan.md §6).
 *
 * One `trigger()` call either starts a pass or, if a pass is already
 * running, sets a dirty flag consumed by exactly one trailing re-run.
 * A pass repeatedly calls `claim()` until it reports "empty", then calls
 * `armWakeup()` once to (re)arm a single timer for the next backoff
 * wake-up, clearing any previously armed timer first.
 */
export type ClaimOutcome = "claimed" | "empty";

export interface DispatcherDeps {
  /** Attempt to claim + start exactly one task. "empty" ends the pass. */
  claim: () => Promise<ClaimOutcome>;
  /** Ms until the earliest future run_after, or null if nothing to wait for. */
  armWakeup: () => Promise<number | null>;
  /** Injectable for tests; defaults to the global timer functions. */
  setTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Floor on any re-arm delay (architecture §8: 25ms). */
  minDelayMs?: number;
}

export interface Dispatcher {
  /**
   * Fire a dispatch pass. Callers that don't need completion just call it
   * without awaiting (fire-and-forget); `start()` awaits the initial call
   * so recovery + first fill complete before the engine reports ready.
   * If a pass is already running, this sets the dirty flag and resolves
   * together with the trailing re-run it caused.
   */
  trigger(): Promise<void>;
  /** Clears any armed wake-up timer without running a pass — used by
   *  engine.stop() so a pending backoff wake-up never fires mid-drain. */
  cancelTimer(): void;
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const setT = deps.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
  const clearT = deps.clearTimeout ?? ((h) => clearTimeout(h));
  const floor = deps.minDelayMs ?? 25;

  let running = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let runPromise: Promise<void> | null = null;

  function clearArmedTimer(): void {
    if (timer !== null) {
      clearT(timer);
      timer = null;
    }
  }

  async function runPass(): Promise<void> {
    clearArmedTimer();
    for (;;) {
      const outcome = await deps.claim();
      if (outcome === "empty") break;
    }
    const delay = await deps.armWakeup();
    if (delay !== null) {
      timer = setT(() => {
        timer = null;
        void trigger();
      }, Math.max(delay, floor));
    }
  }

  async function loop(): Promise<void> {
    running = true;
    do {
      dirty = false;
      await runPass();
    } while (dirty);
    running = false;
  }

  function trigger(): Promise<void> {
    if (running) {
      dirty = true;
      return runPromise ?? Promise.resolve();
    }
    runPromise = loop().finally(() => {
      runPromise = null;
    });
    return runPromise;
  }

  return { trigger, cancelTimer: clearArmedTimer };
}
