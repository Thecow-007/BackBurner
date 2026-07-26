/**
 * Vitest setup for the SPA's component tests (referenced by vite.config.ts).
 *
 * These tests are jsdom-only and never reach the network: the store is driven
 * directly, so there is no server to stand up and nothing to seed. The
 * black-box behaviour of the API itself is covered by the e2e matrix in
 * `packages/e2e`, which is where it belongs — duplicating it here would test
 * the mock, not the product.
 */
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

beforeEach(() => {
  window.localStorage.clear();
});

// jsdom implements neither of these, and both are load-bearing in the SPA:
// EventSource is how the store subscribes, and IntersectionObserver drives the
// register's infinite scroll (ADR 0019). Tests that care about either assert
// against these stubs; tests that do not simply need them to exist.

class MockEventSource {
  static instances: MockEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readyState = MockEventSource.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  /** Drive a frame in from a test, exactly as the server would send it. */
  emit(data: unknown, id: number): void {
    this.readyState = MockEventSource.OPEN;
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data), lastEventId: String(id) }));
  }

  open(): void {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.(new Event("open"));
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }
}

class MockIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  /** Let a test say "the sentinel came into view". */
  trigger(target: Element): void {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }
}

vi.stubGlobal("EventSource", MockEventSource);
vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);

// jsdom has no clipboard; JsonPanel's "copy JSON" affordance writes to it.
if (!navigator.clipboard) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(async () => undefined) },
    configurable: true,
  });
}

// jsdom does not implement matchMedia, which the responsive panes consult.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  })) as unknown as typeof window.matchMedia;
}

// jsdom does not implement scrollIntoView, which focus restoration uses.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}

export { MockEventSource, MockIntersectionObserver };
