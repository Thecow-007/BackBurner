/**
 * The single SSE subscription (docs/frontend-brief.md §5.3, §5.4;
 * docs/api-contract.md §8). Wraps the browser `EventSource`, which the brief
 * mandates precisely because it auto-reconnects and resends `Last-Event-ID`
 * on its own — so a transient drop is recovered by the server replaying
 * exactly what was missed, no fresh snapshot required. Auth is `?api_key=`
 * because `EventSource` cannot set request headers (api-contract §2).
 *
 * Connection lifecycle:
 *   connecting → (onopen) live
 *   live → (onerror) reconnecting            [EventSource retries w/ Last-Event-ID]
 *   reconnecting → (onopen) live             [transient drop recovered]
 *   reconnecting for > STALE_MS → stale, onStale()  [escalate to full resync]
 *
 * Note (transport limitation): `EventSource` does not surface `: hb` heartbeat
 * comment lines to JS, so this client cannot implement the brief's
 * "no event OR heartbeat for 50s" zombie-socket detector directly — it
 * escalates on a *known* disconnect (readyState left OPEN) instead. Catching a
 * silently-dead-but-OPEN socket would require a fetch/ReadableStream reader
 * (which can see heartbeats and set headers); that transport swap is left as a
 * deliberate, separately-decided change, not baked into the data layer here.
 */
import type { ConnectionState, LifecycleEvent } from "./types.js";

const DEFAULT_HEARTBEAT_MS = 20_000;

export interface SseClientOptions {
  apiKey: string;
  /** Initial `?since=` — the `as_of` from the hydration snapshot (§5.1). */
  sinceId: number;
  baseUrl?: string;
  /** Server heartbeat interval; the stale threshold is 2.5× this (§5.3). */
  heartbeatMs?: number;
  /** Called for each parsed lifecycle event, in delivery order. */
  onEvent: (event: LifecycleEvent) => void;
  /** Called on every connection-state change. */
  onState: (state: ConnectionState) => void;
  /** Called once when a disconnect persists past the stale threshold: the
   * store should re-snapshot and re-open from the new `as_of`. */
  onStale: () => void;
}

export class SseClient {
  private es: EventSource | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private disconnectedSince: number | null = null;
  private staleFired = false;
  private closed = false;
  private state: ConnectionState = "connecting";

  private readonly staleMs: number;

  constructor(private readonly opts: SseClientOptions) {
    this.staleMs = 2.5 * (opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  }

  start(): void {
    this.closed = false;
    this.setState("connecting");

    const base = this.opts.baseUrl ?? "";
    const url = new URL(`${base}/events`, base ? undefined : window.location.origin);
    url.searchParams.set("api_key", this.opts.apiKey);
    url.searchParams.set("since", String(this.opts.sinceId));

    const es = new EventSource(url.toString());
    this.es = es;

    es.onopen = () => {
      this.disconnectedSince = null;
      this.staleFired = false;
      this.setState("live");
    };

    es.onmessage = (ev: MessageEvent<string>) => {
      // Any message also proves the connection is alive.
      this.disconnectedSince = null;
      if (this.state !== "live") this.setState("live");

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        return; // malformed data frame — ignore rather than break the stream
      }
      const event: LifecycleEvent = {
        ...(data as object),
        id: Number(ev.lastEventId),
      } as LifecycleEvent;
      if (!Number.isFinite(event.id)) return;
      this.opts.onEvent(event);
    };

    es.onerror = () => {
      // EventSource auto-reconnects (readyState → CONNECTING). Mark the moment
      // we first lost OPEN so the watchdog can escalate if it drags on.
      if (this.disconnectedSince === null) this.disconnectedSince = Date.now();
      if (this.state === "live") this.setState("reconnecting");
    };

    this.watchdog = setInterval(() => this.checkStale(), this.opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  }

  private checkStale(): void {
    if (this.closed || this.disconnectedSince === null || this.staleFired) return;
    if (Date.now() - this.disconnectedSince > this.staleMs) {
      this.staleFired = true;
      this.setState("stale");
      this.opts.onStale();
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onState(state);
  }

  /** Idempotent teardown. The store calls this before opening a fresh client
   * (e.g. on resync from a new `as_of`, or on sign-out). */
  close(): void {
    this.closed = true;
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    if (this.es) {
      this.es.onopen = null;
      this.es.onmessage = null;
      this.es.onerror = null;
      this.es.close();
      this.es = null;
    }
  }
}
