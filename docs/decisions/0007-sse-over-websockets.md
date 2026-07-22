# 0007. Server-sent events over WebSockets

Status: Accepted — 2026-07-21

## Context

The spec permits either SSE or WebSockets for the `/events` stream. The actual requirement is narrow: one-way lifecycle events, a dashboard that updates live, notifications the moment a job finishes, and reconnects that miss nothing. All client *actions* (submit, cancel, retry, collect) already travel over REST. The deployment sits behind a proxy (Cloudflare) that drops idle connections after roughly 100 seconds.

## Decision

SSE. Each event is written as `id: <transition id>` plus `data: <json>` using the default message type, so a bare `EventSource` with one `onmessage` handler consumes the stream. A comment heartbeat (`: hb`) every 20 seconds (`SSE_HEARTBEAT_MS`) keeps the proxy from reaping idle connections. Catch-up is `?since=<id>` on first connect, and the browser's automatic `Last-Event-ID` header on reconnect — both resolve against the transitions table (ADR 0004). Because `EventSource` cannot set request headers, `/events` additionally accepts `?api_key=`; every other authenticated endpoint requires the `Authorization` header (`GET /health` is unauthenticated).

## Alternatives considered

- **WebSockets.** Bidirectional — a capability nothing here uses. The costs are real: no built-in reconnection or resume semantics (Last-Event-ID must be reinvented by hand), an upgrade handshake that is one more thing proxies and middleboxes can mishandle, and a socket protocol where plain HTTP would do.
- **socket.io.** Reconnection handled for us, but behind a proprietary wire protocol. The spec explicitly frames the API as consumable by external scripts and agents — with SSE they need `curl`; with socket.io they need a client library.
- **Long polling.** Works absolutely everywhere, at the price of per-poll latency, connection churn, and hand-rolled cursor semantics that SSE's `Last-Event-ID` provides natively.

## Consequences

- The stream is plain HTTP end to end: `curl -N` demonstrates it, any language consumes it, and the deployed API stays scriptable with zero client dependencies.
- Reconnect-and-resume comes from the platform. Combined with the transactional outbox, a client that vanishes for a minute reconnects and replays exactly the transitions it missed — no gap, no duplicates after id-dedupe.
- The heartbeat is a two-line concession to real-world proxies, verified against the actual deployment rather than assumed.
- Accepted trade: the query-parameter key for `/events` can land in server logs. It is scoped to one endpoint, documented, and the alternative (no header support in `EventSource`) is a platform constraint, not a design choice.
- One-way is a constraint we already met: nothing in the product needed client-to-server push, so nothing was given up.
