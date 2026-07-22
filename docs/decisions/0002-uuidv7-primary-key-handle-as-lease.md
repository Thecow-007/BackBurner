# 0002. UUIDv7 primary key; the handle is a lease

Status: Accepted — 2026-07-21

## Context

The spec's handle recycles: after `scrape-1` is collected, a brand-new job may become `scrape-1`. A recyclable name cannot be a row's identity — foreign keys from the transition history, dashboard detail links, and event correlation all need something that never changes and is never reused. The question is what the immutable identity is and how the handle relates to it.

## Decision

Every task's primary key is `id uuid DEFAULT uuidv7()`, using PostgreSQL 18's native generator. The handle is not stored as a string anywhere: it is derived at serialization time as `lane || '-' || handle_num`, and it is documented as a **lease** — a temporary, recyclable alias that the task holds while active and releases on collect or cancel. Everything durable (transition rows, event payloads via an additive `task_id` field, the dashboard's detail route) references the UUID; only the human-facing surface speaks in handles.

## Alternatives considered

- **`bigint` identity PK.** Smaller keys, faster index. But ids become enumerable across users (a bearer-authenticated API leaking global submission counts), and they carry no timestamp. UUIDv7's embedded time-ordering also makes `id` a coherent tiebreaker wherever rows sort by `created_at`.
- **UUIDv4.** Same non-enumerability, but random inserts scatter across the B-tree (poor locality) and the id carries no ordering information at all. v7 is strictly better here at identical cost.
- **Storing the handle as a string column.** Convenient for queries, but it denormalizes `lane` + `handle_num` into a third place that can drift, and it blurs the design's central claim: the handle is derived, never authoritative.
- **Handle as the primary key.** Structurally impossible — recycling means two different jobs legitimately bear `scrape-1` over time. Any design that fights this is fighting the spec.

## Consequences

- Recycling becomes safe by construction: nothing durable points at a handle, so reuse cannot corrupt history or mislink events.
- Stable identity powers two additive endpoints — `GET /tasks/id/{id}` and `GET /tasks/id/{id}/history` — so the dashboard can link to a task forever, even after its handle belongs to someone new.
- Every SSE event carries `task_id` in addition to the spec's `handle`, because a bare handle is ambiguous the moment it has been recycled.
- Handle resolution for `/tasks/{handle}` needs a documented rule (active holder wins; else most recent former holder; else 404) — a small cost of treating the handle as an alias rather than an identity.
