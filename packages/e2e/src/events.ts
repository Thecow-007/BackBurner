import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import { EventSource } from "eventsource";

import { logTail, type ServerHandle } from "./server.js";
import { T_BOOT } from "./timing.js";

/**
 * One buffered SSE event (test-plan.md §3.5): the `id:` line as a number,
 * plus every field from the parsed `data:` JSON (`type`, `handle`, `lane`,
 * `task_id`, `at`, and any event-specific fields). Always correlate by
 * `task_id` — handles recycle (test-plan.md §3.6 rule 4).
 */
export interface CapturedEvent {
  id: number;
  type: string;
  handle: string;
  lane: string;
  task_id: string;
  at: string;
  [key: string]: unknown;
}

export type EventPredicate = (event: CapturedEvent) => boolean;

export interface EventCaptureOptions {
  /** `?since=` — replay events with id greater than this before going live. */
  since?: number;
  /** Attached to timeout errors from this capture's wait helpers by default;
   * any wait call may override it with its own `server` argument. */
  server?: ServerHandle;
}

export interface AssertNeverOptions {
  /** Predicate for the positive event that bounds the negative assertion
   * (test-plan.md §3.6 rule 3 — negative assertions require a sentinel). */
  sentinel: EventPredicate;
  /** Timeout for the sentinel wait itself. */
  sentinelTimeoutMs: number;
  /** The one blind sleep permitted anywhere in the harness: how much longer
   * to keep capturing after the sentinel arrives before declaring the
   * forbidden predicate absent. Callers pass `T_SETTLE` (timing.ts) unless a
   * criterion specifies otherwise. */
  settleMs: number;
  server?: ServerHandle;
}

/**
 * SSE event client and wait helpers (test-plan.md §3.5), backed by the
 * `eventsource` npm package — the same query-param auth and reconnect
 * behavior a browser `EventSource` uses.
 *
 * The constructor returns before the underlying connection is open (socket
 * setup is asynchronous). Every criteria test connects "before the first
 * submit" specifically so no event can be missed (test-plan.md §4 intro) —
 * callers **must `await capture.ready`** before that first submit, or a
 * request issued immediately after construction can reach the server before
 * the subscriber is attached, silently dropping its `accepted` event.
 */
export class EventCapture {
  private readonly es: InstanceType<typeof EventSource>;
  private readonly emitter = new EventEmitter();
  private readonly buffer: CapturedEvent[] = [];
  private readonly defaultServer: ServerHandle | undefined;
  private closed = false;

  /**
   * Resolves once the SSE connection has actually opened (the `eventsource`
   * package's `onopen`). Rejects — with the usual buffered-events/log-tail
   * diagnostics — if the connection has not opened within `T_BOOT`; never
   * hangs longer than that. Await this before a test's first submit.
   */
  readonly ready: Promise<void>;

  constructor(baseUrl: string, apiKey: string, options: EventCaptureOptions = {}) {
    this.defaultServer = options.server;
    this.emitter.setMaxListeners(0);

    const url = new URL("/events", baseUrl);
    url.searchParams.set("api_key", apiKey);
    if (options.since !== undefined) {
      url.searchParams.set("since", String(options.since));
    }

    this.es = new EventSource(url.toString());
    this.es.onmessage = (ev: MessageEvent) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(ev.data as string) as Record<string, unknown>;
      } catch {
        return; // malformed data: frame — ignore rather than crash the reader
      }
      const captured: CapturedEvent = {
        ...(data as object),
        id: Number(ev.lastEventId),
      } as CapturedEvent;
      this.buffer.push(captured);
      this.emitter.emit("event", captured);
    };
    // EventSource auto-reconnects on transport errors; the harness surfaces
    // failures via wait-helper timeouts (with buffer + log tail attached),
    // not via a thrown error here.
    this.es.onerror = () => {};

    this.ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.es.onopen = null;
        reject(
          this.timeoutError(
            `EventCapture: SSE connection did not open within T_BOOT=${T_BOOT}ms`
          )
        );
      }, T_BOOT);
      this.es.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.es.onopen = null;
        resolve();
      };
    });
  }

  /** Snapshot of every event received so far, oldest first. */
  all(): CapturedEvent[] {
    return [...this.buffer];
  }

  /** Resolves with the first buffered-or-future event matching `predicate`;
   * rejects with `label`, the full buffered event list, and the server log
   * tail if `timeoutMs` elapses first. */
  async waitFor(
    predicate: EventPredicate,
    timeoutMs: number,
    label: string,
    server?: ServerHandle
  ): Promise<CapturedEvent> {
    const existing = this.buffer.find(predicate);
    if (existing) return existing;

    return new Promise<CapturedEvent>((resolve, reject) => {
      const onEvent = (event: CapturedEvent) => {
        if (predicate(event)) {
          cleanup();
          resolve(event);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(this.timeoutError(label, server));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.emitter.off("event", onEvent);
      };
      this.emitter.on("event", onEvent);
    });
  }

  /** Resolves once `n` distinct events matching `predicate` have been seen
   * (buffered already counting), returning them in arrival order. */
  async waitForCount(
    predicate: EventPredicate,
    n: number,
    timeoutMs: number,
    server?: ServerHandle
  ): Promise<CapturedEvent[]> {
    const existing = this.buffer.filter(predicate);
    if (existing.length >= n) return existing.slice(0, n);

    return new Promise<CapturedEvent[]>((resolve, reject) => {
      const check = () => {
        const matches = this.buffer.filter(predicate);
        if (matches.length >= n) {
          cleanup();
          resolve(matches.slice(0, n));
        }
      };
      const onEvent = () => check();
      const timer = setTimeout(() => {
        cleanup();
        reject(
          this.timeoutError(
            `waitForCount: expected ${n} matches, saw ${this.buffer.filter(predicate).length}`,
            server
          )
        );
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.emitter.off("event", onEvent);
      };
      this.emitter.on("event", onEvent);
    });
  }

  /**
   * Negative assertion (test-plan.md §3.5, §3.6 rule 3): waits for the
   * sentinel event, then `settleMs` longer — the only sleep anywhere in the
   * harness — then throws if `predicate` ever matched at any point in the
   * buffer, including before this call.
   */
  async assertNever(predicate: EventPredicate, options: AssertNeverOptions): Promise<void> {
    await this.waitFor(
      options.sentinel,
      options.sentinelTimeoutMs,
      "assertNever: waiting for sentinel",
      options.server
    );
    await delay(options.settleMs);

    const forbidden = this.buffer.find(predicate);
    if (forbidden) {
      const server = options.server ?? this.defaultServer;
      throw new Error(
        `assertNever: forbidden event matched after the sentinel + ${options.settleMs}ms settle window:\n` +
          `${JSON.stringify(forbidden, null, 2)}\n` +
          `--- buffered events (${this.buffer.length}) ---\n${JSON.stringify(this.buffer, null, 2)}\n` +
          `--- server log tail ---\n${server ? logTail(server) : "(no server handle attached)"}`
      );
    }
  }

  /** Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.es.close();
  }

  private timeoutError(label: string, server?: ServerHandle): Error {
    const target = server ?? this.defaultServer;
    return new Error(
      `EventCapture timeout waiting for: ${label}\n` +
        `--- buffered events (${this.buffer.length}) ---\n${JSON.stringify(this.buffer, null, 2)}\n` +
        `--- server log tail ---\n${target ? logTail(target) : "(no server handle attached)"}`
    );
  }
}

export interface RawEventStreamOptions {
  /** `?since=` query parameter. */
  since?: number;
  /** `?api_key=` query parameter — for auth-precedence edge cases; the
   * header is preferred everywhere else (api-contract §2). */
  apiKeyQuery?: string;
  /** Raw request headers, e.g. `{ Authorization: 'Bearer ...' }` or
   * `{ 'Last-Event-ID': '123' }` — the two cases `EventSource` cannot
   * express (it can't set headers at all, and never sends a *request*
   * `Last-Event-ID` header itself). */
  headers?: Record<string, string>;
}

export interface RawEventStreamHandle {
  status: number;
  headers: Headers;
  /** Raw decoded lines as they arrive, including blank separator lines and
   * `: hb` heartbeat comments — the two things `EventSource` is structurally
   * blind to (test-plan.md §3.5). */
  lines: AsyncIterable<string>;
  close(): void;
}

/**
 * Raw `fetch` body reader for the two cases `EventSource` cannot observe:
 * heartbeat comment lines (`: hb`) and sending an explicit `Last-Event-ID`
 * request header (test-plan.md §3.5, §5.5).
 */
export async function rawEventStream(
  baseUrl: string,
  options: RawEventStreamOptions = {}
): Promise<RawEventStreamHandle> {
  const url = new URL("/events", baseUrl);
  if (options.since !== undefined) {
    url.searchParams.set("since", String(options.since));
  }
  if (options.apiKeyQuery !== undefined) {
    url.searchParams.set("api_key", options.apiKeyQuery);
  }

  const controller = new AbortController();
  const res = await fetch(url, { headers: options.headers, signal: controller.signal });

  if (!res.body) {
    throw new Error(`rawEventStream: response had no readable body (status ${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  async function* iterate(): AsyncGenerator<string> {
    let pending = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        pending += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newlineIndex).replace(/\r$/, "");
          pending = pending.slice(newlineIndex + 1);
          yield line;
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      throw err;
    }
  }

  return {
    status: res.status,
    headers: res.headers,
    lines: iterate(),
    close: () => controller.abort(),
  };
}
