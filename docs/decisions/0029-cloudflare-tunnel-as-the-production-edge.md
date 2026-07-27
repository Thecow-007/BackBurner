# 0029. A Cloudflare Tunnel is the production edge, not a proxied A record

Status: Accepted — 2026-07-27

## Context

[deployment.md](../deployment.md) §4 describes the public entry point as "a proxied (orange-cloud) Cloudflare DNS record" pointing at the server, with §1 adding that "Postgres is never exposed publicly — only the app answers external traffic." Written that way, the topology implies an A record resolving to the host's public IP and the app answering on a published port.

Two facts, both discovered during Phase 6, make the literal reading unworkable:

1. **Cloudflare's proxy only connects to origins on a fixed port list** — 80, 443, 8080, 8443, 2052/3, 2082/3, 2086/7, 2095/6. The api listens on 3000 (architecture §13). An orange-clouded A record therefore cannot reach the app without either republishing it on 80/443 or introducing a reverse proxy in front of it.
2. **The server already runs a Cloudflare Tunnel**, which fronts the operator's other services. `cloudflared` is an established, already-authenticated component of that host, sitting on its own Docker network.

Publishing the app on port 80 with Cloudflare's "Flexible" SSL mode would satisfy the port constraint, and was rejected. Flexible leaves the Cloudflare→origin hop in plaintext across the public internet, and BackBurner's entire auth model is a bearer key carried in a request header (api-contract §2). Every reviewer `curl` would put a credential on the wire in the clear, and anyone who learned the origin IP could read it or bypass the proxy entirely.

## Decision

Public traffic reaches the app through the server's existing Cloudflare Tunnel. The app container joins that tunnel's pre-existing Docker network — declared in `docker-compose.yml` as the external network `edge`, its name supplied by `EDGE_NETWORK` — under the alias `backburner`. The tunnel's public-hostname route for `backburner.danielbierman.ca` targets `http://backburner:3000`.

The app publishes **no** public port. Its only host binding is `127.0.0.1:3000`, for the operator to curl when diagnosing whether a fault is the app or the tunnel. Postgres is bound to `127.0.0.1:5432` for the same reason and no other.

A distinct network alias, rather than the compose service name, is deliberate: `edge` is a shared network carrying other stacks, and a generic `app` alias would collide with the next compose project that has a service by that name.

## Alternatives considered

- **Publish on :80, Cloudflare SSL "Flexible."** No new components, but sends bearer keys unencrypted between Cloudflare and the origin and leaves the origin directly reachable in the clear. Rejected on security grounds.
- **Caddy or nginx in the stack with a Cloudflare Origin Certificate, SSL "Full (strict)."** Correct and conventional, and the right answer on a host with no tunnel. Here it would add a second reverse proxy to a machine that already has one, plus certificate lifecycle and a firewall rule restricting 80/443 to Cloudflare's IP ranges — more moving parts than the tunnel that is already running.
- **Bind the app to :8080 and orange-cloud an A record.** Stays within the proxy's port list without a reverse proxy, but requires a public inbound port and still terminates origin TLS nowhere.

## Consequences

- §4's SSE analysis is unchanged and still binding. A tunnel is still Cloudflare's edge, the ~100 s idle cull still applies, and the 20 s `: hb` heartbeat is still what prevents it. The Phase 6 verification — a stream observed alive well past the idle window, and a forced drop recovered via `Last-Event-ID` — runs against the tunnel, because the tunnel is now the proxy under test.
- The DNS record is a proxied CNAME to the tunnel rather than a proxied A record to a host. The reviewer-facing outcome §5 cares about is identical: `https://backburner.danielbierman.ca` with a bearer key, unobstructed, from any network.
- The stack has no publicly reachable port at all. Nothing about it is discoverable by scanning the host's IP.
- The compose file gains a dependency on a network it does not own. It is declared `external`, and because only the prod-profile `app` service attaches to it, compose resolves it lazily — local dev, the test suites, and the devcontainer never require it to exist. That was verified, not assumed.
- If the tunnel is ever retired, the fallback is the Caddy option above; the app itself needs no change, since it already listens on a plain HTTP port and terminates nothing.
