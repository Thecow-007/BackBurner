# BackBurner API Contract

This document is the normative contract for BackBurner's HTTP surface. Anything the server does that this document does not describe is a bug in one of the two.

The contract implements the endpoint list, task object, event shapes, and status vocabulary from the assessment spec ([`docs/assessment-background-job-runner.pdf`](./assessment-background-job-runner.pdf)) **byte-for-byte**, and extends them additively. Every extension is badged:

- **[SPEC]** — required by the assessment spec; names, shapes, and semantics match it exactly.
- **[EXTENSION]** — additive to the spec; documented here with rationale. Extensions never rename, remove, or reshape anything the spec fixes.

Deliberate interpretation calls are collected in [Spec ambiguities and resolutions](#11-spec-ambiguities-and-resolutions).

## Contents

1. [Conventions](#1-conventions)
2. [Authentication](#2-authentication)
3. [Errors](#3-errors)
4. [The task object](#4-the-task-object)
5. [Handles and resolution](#5-handles-and-resolution)
6. [Endpoints](#6-endpoints)
7. [Listing: filters, sort, pagination, as_of](#7-listing-filters-sort-pagination-as_of)
8. [Events (SSE)](#8-events-sse)
9. [Route ownership and SPA coexistence](#9-route-ownership-and-spa-coexistence)
10. [curl quickstart](#10-curl-quickstart)
11. [Spec ambiguities and resolutions](#11-spec-ambiguities-and-resolutions)

---

## 1. Conventions

- Base URL in local development: `http://localhost:3000` (`PORT`, default `3000`).
- All request and response bodies are UTF-8 JSON (`Content-Type: application/json`), except `GET /events`, which is `text/event-stream`.
- The word **lane** is used everywhere a job category appears — in paths, bodies, the task object, and events. The spec's prose says "category"; its API contract says `lane`; the contract wins (see [§11](#11-spec-ambiguities-and-resolutions)).
- **Compatibility rule:** the API only ever evolves additively. Clients must ignore unknown fields on objects and unknown event types on the stream. The spec-fixed fields and shapes will never change.
- CORS is enabled permissively. The API is bearer-authenticated, and external scripts and agents are first-class clients, so browsers may call it from any origin.
- Any endpoint may return `500` with error code `internal_error` on an unexpected fault. Individual endpoint tables below omit it for brevity.

### Endpoint summary

| Method | Path                       | Badge         | Purpose |
|--------|----------------------------|---------------|---------|
| POST   | `/tasks`                   | **[SPEC]**    | Enqueue a job; returns the task object immediately |
| GET    | `/tasks`                   | **[SPEC]**    | List tasks; filters, sort, pagination |
| GET    | `/tasks/{handle}`          | **[SPEC]**    | Fetch one task by handle |
| GET    | `/tasks/{handle}/result`   | **[SPEC]**    | Fetch the result; marks the task collected |
| POST   | `/tasks/{handle}/cancel`   | **[SPEC]**    | Cancel a queued or running task |
| POST   | `/tasks/{handle}/retry`    | **[EXTENSION]** | Operator retry of a failed task |
| GET    | `/tasks/id/{id}`           | **[EXTENSION]** | Fetch one task by immutable id |
| GET    | `/tasks/id/{id}/history`   | **[EXTENSION]** | Full state-transition history of a task |
| GET    | `/events`                  | **[SPEC]**    | SSE stream of lifecycle events |
| GET    | `/health`                  | **[EXTENSION]** | Liveness probe; unauthenticated |

### Registered lanes

Two lanes are registered out of the box, both backed by the mock worker: `scrape` and `report`. The mock worker reads three params:

| Param         | Type    | Behavior |
|---------------|---------|----------|
| `duration_ms` | integer, 1–600000 | Sleep this long. Omitted: a random duration between 3000 and 15000 ms is chosen once, at submit time, and written into the stored `params.duration_ms` — the task object thereafter echoes the filled-in value, retries reuse it (deterministic), and the mock result's `slept_ms` equals it. |
| `fail`        | boolean | `true`: the worker returns a retryable failure with reason `"mock failure requested via params.fail"`. |
| `fail_permanent` | boolean | `true`: the worker returns a **non-retryable** failure with reason `"mock permanent failure requested via params.fail_permanent"` — the task lands in `failed` on its first attempt, attempt budget ignored. Wins over `fail` when both are set. Operator retry remains available afterward: `retryable: false` gates auto-retry only. |

Extra `params` keys are accepted and passed through to the worker untouched.

Neither `scrape` nor `report` configures a per-lane `maxAttempts` default; both fall through to the global default of 3. Per-lane defaults exist as an engine capability ([§6.1](#61-post-tasks--spec)'s "the lane's configured default") but are unused by the bundled registry.

---

## 2. Authentication

Every endpoint except `GET /health` requires authentication.

**Primary scheme — everywhere:**

```
Authorization: Bearer <api key>
```

**Exception — `GET /events` only** additionally accepts the key as a query parameter:

```
GET /events?api_key=<api key>
```

This exists for exactly one reason: the browser `EventSource` API cannot set request headers, and the dashboard consumes `/events` through `EventSource`. Non-browser clients should prefer the header — query strings can end up in proxy and access logs. If both are supplied, the `Authorization` header wins. No other endpoint accepts `?api_key=`.

### Key format

Keys have the form `bb_` followed by 40 lowercase hex characters (43 characters total), e.g. `bb_9f2ce4a1b7d8036c5e12f409ab87cd3210fe6b54`. The server stores only the SHA-256 hex digest of the full key; raw keys are printed exactly once, by the seed script. A lost key cannot be recovered, only reissued.

### Scoping

Every read, write, and event stream is strictly scoped to the authenticated key's user:

- `GET /tasks` returns only that user's tasks; `/events` carries only that user's lifecycle events.
- Handle namespaces are per-user: two users can each own a `scrape-1` with no interaction.
- A handle or id belonging to another user is indistinguishable from one that does not exist: the response is `404 not_found`, never `403`. This avoids turning the API into an existence oracle for other users' data.

### Failure

A missing header, a malformed header, an unknown key, or a wrong scheme all produce `401` with code `unauthorized` in the standard envelope. The response does not distinguish which of these occurred.

---

## 3. Errors

Every non-2xx response carries a single envelope. For `GET /events`, errors can only occur at connect time (before the stream opens) and are ordinary JSON envelope responses; once the stream is open, no further HTTP status can be conveyed.

```json
{
  "error": {
    "code": "invalid_state",
    "message": "scrape-1 is running; the result is only available once a task is ready or failed.",
    "current_status": "running"
  }
}
```

- `code` — machine-readable, `snake_case`, from the closed table below. Branch on this, never on `message`.
- `message` — one human-readable sentence. Wording may change without notice.
- Additional context fields may appear per code (e.g. `current_status`); they are part of the contract where listed.

| Code             | HTTP | When | Context fields |
|------------------|------|------|----------------|
| `unauthorized`   | 401  | Missing, malformed, or unknown API key | — |
| `invalid_params` | 400  | Body, query, or path parameter fails validation | — |
| `unknown_lane`   | 400  | `POST /tasks` with a lane no worker is registered for | `lane` — the rejected value |
| `not_found`      | 404  | No task resolves for the handle/id, or the resource belongs to another user | — |
| `invalid_state`  | 409  | The requested transition is not legal from the task's current status | `current_status` — the task's actual status at rejection time |
| `internal_error` | 500  | Unexpected server fault | — |

A syntactically invalid JSON body is also mapped onto the standard envelope with code `invalid_params` — the framework's default body-parse error is intercepted, never leaked raw.

`409 invalid_state` deserves a note: every state change in the engine is a compare-and-swap on the expected current status. When the swap matches zero rows — the task moved meanwhile, or was never in the required state — the API reports the status the task actually has, so a client can resynchronize without a second round trip.

---

## 4. The task object

Returned by every task endpoint. The nine spec fields are byte-for-byte; four additive fields are extensions.

```json
{
  "handle": "scrape-1",
  "lane": "scrape",
  "params": { "duration_ms": 10000 },
  "status": "queued",
  "result": null,
  "error": null,
  "created_at": "2026-07-21T18:00:00.000Z",
  "updated_at": "2026-07-21T18:00:00.000Z",
  "collected": false,
  "id": "01981fa0-4b2d-7d31-9e5a-8c2f6b1d4e7a",
  "attempts": 0,
  "max_attempts": 3,
  "seeded": false
}
```

### Spec fields — [SPEC]

| Field        | Type | Semantics |
|--------------|------|-----------|
| `handle`     | string | `<lane>-<number>`, e.g. `scrape-1`. A leased, recyclable alias — see [§5](#5-handles-and-resolution). |
| `lane`       | string | The job's lane (category). |
| `params`     | object | The params supplied at submit, echoed as stored. One documented fill-in: when `duration_ms` is omitted on a mock-worker lane, the engine writes the randomly chosen duration into the stored params at submit ([§1](#registered-lanes)), so the echo includes it. |
| `status`     | string | One of `queued`, `running`, `ready`, `failed`, `cancelled`. |
| `result`     | any \| null | Worker result. Non-null **only** when `status` is `ready`. |
| `error`      | object \| null | `{ "reason": string, "retryable": boolean }`. Non-null **only** when `status` is `failed`. |
| `created_at` | string | Submission time. |
| `updated_at` | string | Time of the most recent state change. |
| `collected`  | boolean | Flips to `true` once the result is retrieved via `GET /tasks/{handle}/result`. |

### Additive fields — [EXTENSION]

| Field          | Type | Why it exists |
|----------------|------|---------------|
| `id`           | string (UUIDv7) | Immutable primary identity. Handles recycle; `id` never does. Use it for permanent references (`/tasks/id/{id}`) and event correlation. |
| `attempts`     | integer | Execution attempts consumed so far. Increments when a worker claims the task. Reset to 0 by operator retry. |
| `max_attempts` | integer | Attempt budget (1–10, default 3). Auto-retry stops when `attempts` reaches it. |
| `seeded`       | boolean | `true` for synthetic seed data, so demo rows are never mistaken for real processing. |

### Visibility rules

The serializer — not the database — enforces the spec's visibility guarantees:

- `result` is serialized as `null` unless `status` is `ready`.
- `error` is serialized as `null` unless `status` is `failed`.

Storage may retain history the API does not show. Example: after an operator retries a failed task, the task returns to `queued` and its `error` serializes as `null` immediately, even before the stored error is superseded. Clients can always trust that a non-null `result` means `ready` and a non-null `error` means `failed`.

### Timestamps

All timestamps in the API — task fields, event `at`, history `at`, filter inputs — are ISO-8601 UTC with millisecond precision and a `Z` suffix: `2026-07-21T18:00:00.000Z`.

### Status lifecycle

```mermaid
stateDiagram-v2
    [*] --> queued: POST /tasks
    queued --> running: dispatcher claims a slot
    queued --> cancelled: POST cancel
    running --> ready: worker success
    running --> queued: retryable failure, budget left (auto-retry with backoff)
    running --> failed: non-retryable, or budget exhausted
    running --> cancelled: POST cancel (worker aborted)
    failed --> queued: POST retry (operator, fresh budget, uncollected only)
```

Collection is deliberately absent from the diagram: `GET /tasks/{handle}/result` does not change `status`. It flips `collected` to `true` on a `ready` **or** `failed` task, which releases the handle. `failed` is never auto-retried and never auto-collected — it means "awaiting an operator decision", and the operator's two verbs on it are retry (while uncollected) or collect/acknowledge.

---

## 5. Handles and resolution

A handle is `<lane>-<number>` with the number ≥ 1, assigned per user per lane. It is **derived** from the task's lane and number at serialization time — never stored as a string — and it is a *lease*, not an identity:

- A task is **active** (holds its handle) while it is in-flight (`queued` or `running`) or finished-but-uncollected (`ready` or `failed`, not yet collected).
- The handle is released when the task is **collected or cancelled**. The next submit in that lane takes the **lowest free number** — so `scrape-1` may be reused the moment its previous owner is collected or cancelled, but never while that owner is active. Failed tasks keep their handle until the operator retries or collects them.
- Handle assignment is transactional and race-safe: concurrent submits in the same lane always receive distinct numbers.

Lane names are constrained at registration time: `createEngine` rejects, with a startup error, any registered lane whose name does not match `^[a-z][a-z0-9_-]*$`. Lane names appear verbatim in URL paths and in every handle, so the constraint keeps both well-formed by construction.

### Resolution of `{handle}` path parameters

Applies to `GET /tasks/{handle}`, `GET /tasks/{handle}/result`, `POST /tasks/{handle}/cancel`, `POST /tasks/{handle}/retry`:

1. **Parse.** A handle matches the canonical grammar `^(<lane>)-([1-9][0-9]*)$`: split at the last `-`, the left side is the lane, the right side is the number — no leading zeros. Non-canonical numbers (`scrape-01`) and otherwise unparseable handles → `404 not_found`; every task has exactly one handle string that resolves to it.
2. **Active holder wins.** If a task is currently active under `(user, lane, number)`, the handle resolves to it. There is at most one, by construction.
3. **Otherwise, the most recent former holder.** Among that user's inactive tasks that held this handle, the most recently created wins.
4. **Otherwise `404`.**

Rationale for step 3: after you collect `scrape-1`, `GET /tasks/scrape-1` keeps returning that task — its result stays visible — until a new task actually claims the handle. Without this rule, collecting a task would instantly make its handle a 404, which is hostile to scripts that collect and then re-read.

Consequences worth internalizing:

- Action endpoints resolve **first**, then check state. Cancelling a handle that currently resolves to a collected former holder returns `409 invalid_state` (the task exists; the transition is illegal), not `404`.
- A handle is only a stable reference while its task is active. The moment it is released it can be re-leased; the old task then becomes reachable only via `GET /tasks/id/{id}`. Dashboards and scripts that store references should store `id`.

---

## 6. Endpoints

### 6.1 `POST /tasks` — [SPEC]

Enqueue a job. Returns the task object immediately, with a freshly leased handle, before any work runs. This endpoint never blocks on the job: the response arrives in milliseconds regardless of `duration_ms`.

**Request body**

| Field          | Type    | Required | Constraints |
|----------------|---------|----------|-------------|
| `lane`         | string  | yes      | Must be a registered lane, else `400 unknown_lane`. |
| `params`       | object  | no       | Default `{}`. `duration_ms`: integer 1–600000. `fail`, `fail_permanent`: booleans. Other keys pass through untouched. |
| `max_attempts` | integer | no       | 1–10. Default: the lane's configured default, else 3. |

Unknown top-level body fields are rejected with `400 invalid_params` (the free-form area is `params`, nothing else).

**Example**

```
POST /tasks
Authorization: Bearer bb_9f2ce4a1b7d8036c5e12f409ab87cd3210fe6b54
Content-Type: application/json
```

```json
{
  "lane": "scrape",
  "params": { "duration_ms": 10000 }
}
```

**Response — `201 Created`**

```json
{
  "handle": "scrape-1",
  "lane": "scrape",
  "params": { "duration_ms": 10000 },
  "status": "queued",
  "result": null,
  "error": null,
  "created_at": "2026-07-21T18:00:00.000Z",
  "updated_at": "2026-07-21T18:00:00.000Z",
  "collected": false,
  "id": "01981fa0-4b2d-7d31-9e5a-8c2f6b1d4e7a",
  "attempts": 0,
  "max_attempts": 3,
  "seeded": false
}
```

An `accepted` event is emitted on `/events` at the same time.

**Status codes**

| Code | Error code | When |
|------|-----------|------|
| 201  | —         | Task enqueued |
| 400  | `unknown_lane` | No worker registered for `lane` |
| 400  | `invalid_params` | Malformed body, bad `params.duration_ms` / `params.fail` / `params.fail_permanent`, `max_attempts` out of range, unknown top-level field |
| 401  | `unauthorized` | Bad or missing key |

---

### 6.2 `GET /tasks` — [SPEC]

List the authenticated user's tasks. Filters, sort, and pagination are specified in [§7](#7-listing-filters-sort-pagination-as_of).

**Example**

```
GET /tasks?status=running&lane=scrape&limit=2
Authorization: Bearer bb_9f2ce4a1b7d8036c5e12f409ab87cd3210fe6b54
```

**Response — `200 OK`**

```json
{
  "tasks": [
    {
      "handle": "scrape-2",
      "lane": "scrape",
      "params": { "duration_ms": 30000 },
      "status": "running",
      "result": null,
      "error": null,
      "created_at": "2026-07-21T18:02:10.000Z",
      "updated_at": "2026-07-21T18:02:10.510Z",
      "collected": false,
      "id": "01981fa2-6c1e-7f02-8a3b-5d4e9c0f1a2b",
      "attempts": 1,
      "max_attempts": 3,
      "seeded": false
    },
    {
      "handle": "scrape-1",
      "lane": "scrape",
      "params": { "duration_ms": 10000 },
      "status": "running",
      "result": null,
      "error": null,
      "created_at": "2026-07-21T18:00:00.000Z",
      "updated_at": "2026-07-21T18:00:00.412Z",
      "collected": false,
      "id": "01981fa0-4b2d-7d31-9e5a-8c2f6b1d4e7a",
      "attempts": 1,
      "max_attempts": 3,
      "seeded": false
    }
  ],
  "as_of": 4131,
  "next_cursor": null
}
```

The envelope fields `as_of` and `next_cursor` are **[EXTENSION]** — the task objects inside are spec-shaped. `as_of` is the event cursor for gap-free SSE hydration ([§7](#7-listing-filters-sort-pagination-as_of)).

**Status codes**

| Code | Error code | When |
|------|-----------|------|
| 200  | —         | Always, including an empty list |
| 400  | `invalid_params` | Unknown status value, bad date, bad sort spec, limit out of range, invalid cursor |
| 401  | `unauthorized` | Bad or missing key |

---

### 6.3 `GET /tasks/{handle}` — [SPEC]

Fetch one task by handle, per the resolution rules in [§5](#5-handles-and-resolution).

**Example**

```
GET /tasks/scrape-1
Authorization: Bearer bb_9f2ce4a1b7d8036c5e12f409ab87cd3210fe6b54
```

**Response — `200 OK`** — a task object (here, mid-run):

```json
{
  "handle": "scrape-1",
  "lane": "scrape",
  "params": { "duration_ms": 10000 },
  "status": "running",
  "result": null,
  "error": null,
  "created_at": "2026-07-21T18:00:00.000Z",
  "updated_at": "2026-07-21T18:00:00.412Z",
  "collected": false,
  "id": "01981fa0-4b2d-7d31-9e5a-8c2f6b1d4e7a",
  "attempts": 1,
  "max_attempts": 3,
  "seeded": false
}
```

**Status codes**

| Code | Error code | When |
|------|-----------|------|
| 200  | —         | Handle resolved (active holder or most recent former holder) |
| 401  | `unauthorized` | Bad or missing key |
| 404  | `not_found` | Unparseable handle, no holder ever, or the handle belongs to another user |

---

### 6.4 `GET /tasks/{handle}/result` — [SPEC]

Fetch the result and mark the task collected. **This is the one GET with a side effect — the spec fixes the method.** Semantics:

- Legal when the resolved task's status is `ready` **or** `failed`. Any other status → `409 invalid_state` with `current_status`.
- On first call: `collected` flips to `true`, the handle is released for reuse, and a `collected` event is emitted. This acknowledges the outcome either way — success or failure — it never touches `result` or `error`.
- On subsequent calls **while the handle still resolves to the same task**: `200` with the identical body, idempotently — no state change, no new event.
- Once the handle has been re-leased to a new task, this path addresses the new task. The old task's result remains readable via `GET /tasks/id/{id}` (its status stays `ready` or `failed`, so `result`/`error` stays visible).

The response is the **full task object** with `result` populated iff `ready` and `error` populated iff `failed`, plus `collected: true` — not the bare result value. It is self-describing and consistent with every other endpoint; the result itself is under `result` (see [§11](#11-spec-ambiguities-and-resolutions)).

Because collection has a side effect, well-behaved UI clients (including the bundled dashboard) only call it on an explicit user action, never as an automatic fetch.

**Example**

```
GET /tasks/scrape-1/result
Authorization: Bearer bb_9f2ce4a1b7d8036c5e12f409ab87cd3210fe6b54
```

**Response — `200 OK`**

```json
{
  "handle": "scrape-1",
  "lane": "scrape",
  "params": { "duration_ms": 10000 },
  "status": "ready",
  "result": { "message": "scrape-1 completed", "slept_ms": 10000 },
  "error": null,
  "created_at": "2026-07-21T18:00:00.000Z",
  "updated_at": "2026-07-21T18:00:10.400Z",
  "collected": true,
  "id": "01981fa0-4b2d-7d31-9e5a-8c2f6b1d4e7a",
  "attempts": 1,
  "max_attempts": 3,
  "seeded": false
}
```

**Response — `409 Conflict`** (task not ready):

```json
{
  "error": {
    "code": "invalid_state",
    "message": "scrape-1 is running; the result is only available once a task is ready or failed.",
    "current_status": "running"
  }
}
```

**Status codes**

| Code | Error code | When |
|------|-----------|------|
| 200  | —         | Collected (first call, from `ready` or `failed`) or re-read while the handle still resolves here |
| 401  | `unauthorized` | Bad or missing key |
| 404  | `not_found` | Handle does not resolve |
| 409  | `invalid_state` | Status is `queued`, `running`, or `cancelled` |

---

### 6.5 `POST /tasks/{handle}/cancel` — [SPEC]

Cancel a queued or running task. Legal only from `queued` or `running` — spec wording, byte-for-byte:

- **`queued`** → `cancelled` before any work starts.
- **`running`** → the task is marked `cancelled` first, then its worker's `AbortSignal` fires. The worker actually stops; no later `ready` (or `failed`) event will ever arrive for a cancelled task. If a worker's result races the cancellation, the result is discarded silently.

Cancelling releases the handle. Cancel from `ready`, `failed`, or `cancelled` → `409` (`ready` and `failed` tasks are released by collection, not cancellation; `cancelled` is terminal). A failed task has already stopped running — there is nothing left to cancel; the operator's options on it are retry or collect (see [§11](#11-spec-ambiguities-and-resolutions)).

**Example**

```
POST /tasks/scrape-2/cancel
Authorization: Bearer bb_9f2ce4a1b7d8036c5e12f409ab87cd3210fe6b54
```

**Response — `200 OK`**

```json
{
  "handle": "scrape-2",
  "lane": "scrape",
  "params": { "duration_ms": 30000 },
  "status": "cancelled",
  "result": null,
  "error": null,
  "created_at": "2026-07-21T18:02:10.000Z",
  "updated_at": "2026-07-21T18:02:31.088Z",
  "collected": false,
  "id": "01981fa2-6c1e-7f02-8a3b-5d4e9c0f1a2b",
  "attempts": 1,
  "max_attempts": 3,
  "seeded": false
}
```

**Status codes**

| Code | Error code | When |
|------|-----------|------|
| 200  | —         | Cancelled from `queued` or `running` |
| 401  | `unauthorized` | Bad or missing key |
| 404  | `not_found` | Handle does not resolve |
| 409  | `invalid_state` | Status is `ready`, `failed`, or `cancelled` (context: `current_status`) |

---

### 6.6 `POST /tasks/{handle}/retry` — [EXTENSION]

Operator retry of a failed task. The spec requires that "the operator decides when to retry" permanently failed jobs and that the dashboard exposes a retry action — and since the dashboard is a pure API consumer, the capability must exist as an endpoint.

Legal **only** from `failed`, and only while **uncollected** — once a failed task has been collected, the operator has acknowledged it and retry is retired for good (`409 invalid_state`). The task returns to `queued` with a **fresh attempt budget** (`attempts` reset to 0) and no backoff delay — an explicit human decision should not inherit the exhausted budget or wait out a timer. Emits a `retrying` event with `operator: true`.

**Example**

```
POST /tasks/report-1/retry
Authorization: Bearer bb_9f2ce4a1b7d8036c5e12f409ab87cd3210fe6b54
```

**Response — `200 OK`**

```json
{
  "handle": "report-1",
  "lane": "report",
  "params": { "fail": true },
  "status": "queued",
  "result": null,
  "error": null,
  "created_at": "2026-07-21T17:40:00.000Z",
  "updated_at": "2026-07-21T18:05:12.300Z",
  "collected": false,
  "id": "01981f8e-1a2b-7c3d-8e4f-6a5b4c3d2e1f",
  "attempts": 0,
  "max_attempts": 3,
  "seeded": false
}
```

**Status codes**

| Code | Error code | When |
|------|-----------|------|
| 200  | —         | Re-queued from `failed`, uncollected |
| 401  | `unauthorized` | Bad or missing key |
| 404  | `not_found` | Handle does not resolve |
| 409  | `invalid_state` | Status is anything other than `failed`, or the failed task is already `collected` (context: `current_status`) |

---

### 6.7 `GET /tasks/id/{id}` — [EXTENSION]

Fetch one task by its immutable UUIDv7 `id`. Exists because handles recycle: once `scrape-1` is re-leased, its former owner is unreachable by handle, but dashboards need stable detail links and scripts need permanent references. The literal path segment `id` can never collide with a handle (handles always end in `-<number>`).

**Example**

```
GET /tasks/id/01981fa0-4b2d-7d31-9e5a-8c2f6b1d4e7a
Authorization: Bearer bb_9f2ce4a1b7d8036c5e12f409ab87cd3210fe6b54
```

**Response — `200 OK`** — a task object, identical in shape to §6.3.

**Status codes**

| Code | Error code | When |
|------|-----------|------|
| 200  | —         | Task exists and belongs to the caller |
| 400  | `invalid_params` | `{id}` is not a syntactically valid UUID |
| 401  | `unauthorized` | Bad or missing key |
| 404  | `not_found` | No such task, or it belongs to another user |

---

### 6.8 `GET /tasks/id/{id}/history` — [EXTENSION]

The task's complete state-transition history, oldest first. Powers the per-item "state history with timestamps" view the spec requires of the dashboard; exposed over HTTP so any client gets it.

**Example**

```
GET /tasks/id/01981fa0-4b2d-7d31-9e5a-8c2f6b1d4e7a/history
Authorization: Bearer bb_9f2ce4a1b7d8036c5e12f409ab87cd3210fe6b54
```

**Response — `200 OK`**

```json
{
  "transitions": [
    { "event_type": "accepted",  "from_status": null,      "to_status": "queued",  "at": "2026-07-21T18:00:00.000Z", "meta": { "summary": "scrape-1 queued" } },
    { "event_type": "running",   "from_status": "queued",  "to_status": "running", "at": "2026-07-21T18:00:00.412Z", "meta": { "attempt": 1, "max_attempts": 3 } },
    { "event_type": "ready",     "from_status": "running", "to_status": "ready",   "at": "2026-07-21T18:00:10.400Z", "meta": { "summary": "scrape-1 finished in 10.2s" } },
    { "event_type": "collected", "from_status": "ready",   "to_status": "ready",   "at": "2026-07-21T18:01:02.000Z", "meta": {} }
  ]
}
```

| Field | Type | Semantics |
|-------|------|-----------|
| `event_type`  | string | One of the event vocabulary in [§8](#event-vocabulary): `accepted`, `running`, `retrying`, `ready`, `failed`, `cancelled`, `collected`. |
| `from_status` | string \| null | Status before the transition; `null` for `accepted`. |
| `to_status`   | string \| null | Status after the transition. `collected` records `ready` → `ready` or `failed` → `failed` (the flag flip, not a status change). |
| `at`          | string | When the transition committed. |
| `meta`        | object | Holds the event's non-derivable payload fields — everything needed to render the corresponding SSE event byte-identically on replay. Contents by event type below. |

Per-event-type `meta` contents:

| Event type | `meta` |
|------------|--------|
| `accepted`, `ready` | `{ summary }` |
| `failed`            | `{ reason, retryable }` |
| `running`           | `{ attempt, max_attempts }` |
| `retrying`          | `{ attempt, max_attempts, reason?, run_after?, operator?, recovery? }` |
| `collected`, `cancelled` | `{}` |

SSE replay is journal-driven, and `summary`/`reason`/`retryable` are spec fields on those events, so the journal must store them — replay cannot re-derive them after the fact.

**Status codes**

| Code | Error code | When |
|------|-----------|------|
| 200  | —         | Task exists and belongs to the caller |
| 400  | `invalid_params` | `{id}` is not a syntactically valid UUID |
| 401  | `unauthorized` | Bad or missing key |
| 404  | `not_found` | No such task, or it belongs to another user |

---

### 6.9 `GET /events` — [SPEC]

The SSE lifecycle stream. Fully specified in [§8](#8-events-sse).

**Status codes**

| Code | Error code | When |
|------|-----------|------|
| 200  | —         | Stream opens (`Content-Type: text/event-stream`) |
| 400  | `invalid_params` | `?since=` is not a non-negative integer |
| 401  | `unauthorized` | No valid key in header or `?api_key=` |

---

### 6.10 `GET /health` — [EXTENSION]

Unauthenticated liveness probe for deploy checks and container orchestration.

**Response — `200 OK`**

```json
{ "status": "ok" }
```

---

## 7. Listing: filters, sort, pagination, as_of

All parameters apply to `GET /tasks` and combine freely. Invalid values are rejected with `400 invalid_params` — never silently ignored or clamped.

| Parameter | Badge | Values | Semantics |
|-----------|-------|--------|-----------|
| `status`  | **[SPEC]** | one of the five statuses | Exact match. |
| `lane`    | **[SPEC]** | string | Exact match. Filtering by a lane that has no tasks (or is not registered) returns an empty list, not an error. |
| `from`    | **[EXTENSION]** | ISO-8601 timestamp | `created_at >= from` (inclusive). Date-only input (`2026-07-01`) is read as `00:00:00.000Z`. |
| `to`      | **[EXTENSION]** | ISO-8601 timestamp | `created_at < to` (exclusive). Half-open `[from, to)` ranges compose cleanly across pages of days. |
| `sort`    | **[EXTENSION]** | `created_at` or `updated_at`, optionally `:asc`/`:desc` | Default `created_at:desc` (newest first). Direction defaults to `desc`. Ties broken by `id` in the same direction, so ordering is total and stable. |
| `limit`   | **[EXTENSION]** | integer 1–200 | Page size. Default 50. |
| `cursor`  | **[EXTENSION]** | opaque string | Resume token from a previous response's `next_cursor`. |

### Pagination

Keyset pagination. Each response carries `next_cursor`: an opaque token (do not parse or construct it) when more rows match, `null` on the last page. The cursor encodes only the position — clients must resend the **same filter and sort parameters** with it; changing them mid-pagination yields undefined results. Keyset cursors stay correct while new tasks are inserted: rows are never skipped or duplicated the way offset pagination would.

### `as_of` — the snapshot-to-stream bridge

`as_of` is the id of the most recent lifecycle event affecting the caller's tasks at the moment the snapshot was taken (`0` if none). It is exactly the value to pass as `?since=` when opening `/events`, making snapshot-then-stream hydration gap-free — every event after the snapshot is delivered, nothing is missed between the two requests, and replayed events the snapshot already reflects are harmless to re-apply.

The read ordering is pinned: the server computes `as_of` **before** (or in the same transaction snapshot as) the task-list query. `as_of` may therefore under-state the snapshot — an event committing between the two reads is reflected in the list yet still has an id greater than `as_of` — but never over-state it; the resulting replay overlap is harmless because clients apply events idempotently by id. The reverse order would be a bug: an event committing between the list query and a later `as_of` read would be absent from the snapshot yet ≤ `as_of` — silently lost to `?since=as_of`.

```mermaid
sequenceDiagram
    participant C as Client
    participant A as API
    C->>A: GET /tasks (Bearer)
    A-->>C: 200 tasks + as_of=4131
    C->>A: GET /events?since=4131
    A-->>C: replay of events with id > 4131
    A-->>C: live events as they commit
```

This is how the bundled dashboard works: hydrate once, then apply events — no polling.

---

## 8. Events (SSE)

`GET /events` streams lifecycle events as Server-Sent Events. The stream carries **only the authenticated user's tasks' events**, in commit order.

### Connecting

```
GET /events?since=4131
Authorization: Bearer bb_9f2ce4a1b7d8036c5e12f409ab87cd3210fe6b54
```

or, from a browser `EventSource` (which cannot set headers — see [§2](#2-authentication)):

```
GET /events?since=4131&api_key=bb_9f2ce4a1b7d8036c5e12f409ab87cd3210fe6b54
```

Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`. The connection stays open indefinitely.

### Wire format

Events use the SSE default message type — no `event:` field, so a plain `onmessage` handler receives everything. Each event is an `id:` line (the event's cursor) plus a `data:` line of JSON:

```
id: 4132
data: {"type":"accepted","handle":"scrape-1","lane":"scrape","summary":"scrape-1 queued","task_id":"01981fa0-4b2d-7d31-9e5a-8c2f6b1d4e7a","at":"2026-07-21T18:00:00.000Z"}

: hb

id: 4133
data: {"type":"running","handle":"scrape-1","lane":"scrape","task_id":"01981fa0-4b2d-7d31-9e5a-8c2f6b1d4e7a","at":"2026-07-21T18:00:00.412Z","attempt":1,"max_attempts":3}
```

- **Event ids** are strictly increasing integers drawn from a global sequence — treat them as an opaque, monotonic cursor. Consecutive events on one user's stream are increasing but **not contiguous** (other users' events consume ids too). The mechanism behind the guarantee: transition commits are serialized per user by a short advisory transaction lock taken before the journal insert (see [architecture §11](./architecture.md#11-durability-and-recovery)), so within one user's stream journal-id order equals commit order — this is what makes "in commit order", strictly increasing live delivery, and id-cursor replay jointly satisfiable.
- **Heartbeat**: a comment line `: hb` every 20 seconds (`SSE_HEARTBEAT_MS`) keeps proxies from dropping idle connections (Cloudflare, for one, cuts streams idle for ~100 s). `EventSource` ignores comments; other consumers should too.

### Catch-up: `?since` and `Last-Event-ID`

- `?since=<id>` — replay every event for this user with id **greater than** `<id>`, in order, then continue live. `?since=0` replays the user's full history of real tasks; seeded tasks' synthetic transitions are journaled for the history endpoint but excluded from `/events` replay (seed data is historical — it must never generate live-looking events or notifications). Omitted: live-only from the moment of connection.
- `Last-Event-ID` — sent automatically by `EventSource` on reconnect with the last `id:` it processed; treated exactly like `?since`. When both are present, `Last-Event-ID` wins (it is by definition the more recent position).
- Each event is delivered at most once per connection: replay and live are deduplicated by id at the boundary.

Pair `?since` with the `as_of` value from `GET /tasks` for gap-free hydration ([§7](#as_of--the-snapshot-to-stream-bridge)).

### Event vocabulary

The four spec event types keep their spec shapes byte-for-byte. Every event — spec and extension — additionally carries two **[EXTENSION]** fields:

| Field     | Type | Why it exists on every event |
|-----------|------|------------------------------|
| `task_id` | string | Handles are recycled aliases: two different tasks can legitimately emit events as `scrape-1` within one session, so a bare handle is ambiguous to correlate. `task_id` pins each event to exactly one task. |
| `at`      | string | When the transition committed, so clients can order and display timelines without trusting delivery time (replayed events would otherwise all "happen" at reconnect). |

| Type        | Badge | Emitted when | Fields beyond `type`, `handle`, `lane`, `task_id`, `at` |
|-------------|-------|--------------|----------------------------------------------------------|
| `accepted`  | **[SPEC]** | Task enqueued | `summary` |
| `running`   | **[EXTENSION]** | Worker claims the task | `attempt`, `max_attempts` |
| `retrying`  | **[EXTENSION]** | Auto-retry scheduled, operator retry, or boot recovery re-queue | `attempt`, `max_attempts`, and when applicable `reason`, `run_after`, `operator`, `recovery` |
| `ready`     | **[SPEC]** | Worker succeeded | `summary` |
| `failed`    | **[SPEC]** | Permanent failure (non-retryable, or budget exhausted) | `reason`, `retryable` |
| `cancelled` | **[SPEC]** | Task cancelled | — |
| `collected` | **[EXTENSION]** | Result or error acknowledged (from `ready` or `failed`); handle released | — |

The extension types exist because the spec's four cover completion but not observation: a live dashboard must show a task *entering* `running`, retries backing off, and handles being freed — without polling. Clients that only understand the spec four can ignore the rest and remain fully correct about terminal outcomes.

One example per type:

```json
{ "type": "accepted", "handle": "scrape-1", "lane": "scrape", "summary": "scrape-1 queued", "task_id": "01981fa0-4b2d-7d31-9e5a-8c2f6b1d4e7a", "at": "2026-07-21T18:00:00.000Z" }
```

```json
{ "type": "running", "handle": "scrape-1", "lane": "scrape", "task_id": "01981fa0-4b2d-7d31-9e5a-8c2f6b1d4e7a", "at": "2026-07-21T18:00:00.412Z", "attempt": 1, "max_attempts": 3 }
```

```json
{ "type": "retrying", "handle": "report-1", "lane": "report", "task_id": "01981f8e-1a2b-7c3d-8e4f-6a5b4c3d2e1f", "at": "2026-07-21T18:00:05.130Z", "attempt": 1, "max_attempts": 3, "reason": "mock failure requested via params.fail", "run_after": "2026-07-21T18:00:07.200Z" }
```

```json
{ "type": "ready", "handle": "scrape-1", "lane": "scrape", "summary": "scrape-1 finished in 10.2s", "task_id": "01981fa0-4b2d-7d31-9e5a-8c2f6b1d4e7a", "at": "2026-07-21T18:00:10.400Z" }
```

```json
{ "type": "failed", "handle": "report-1", "lane": "report", "reason": "mock failure requested via params.fail", "retryable": true, "task_id": "01981f8e-1a2b-7c3d-8e4f-6a5b4c3d2e1f", "at": "2026-07-21T18:00:14.020Z" }
```

```json
{ "type": "cancelled", "handle": "scrape-2", "lane": "scrape", "task_id": "01981fa2-6c1e-7f02-8a3b-5d4e9c0f1a2b", "at": "2026-07-21T18:02:31.088Z" }
```

```json
{ "type": "collected", "handle": "scrape-1", "lane": "scrape", "task_id": "01981fa0-4b2d-7d31-9e5a-8c2f6b1d4e7a", "at": "2026-07-21T18:01:02.000Z" }
```

Notes on `retrying`: `attempt` is the number of attempts consumed so far; `reason` is present for auto-retries (the failure that triggered the retry); `run_after` is when the task becomes eligible again (exponential backoff with jitter); `operator: true` marks an operator retry via `POST /tasks/{handle}/retry`; `recovery: true` marks a re-queue by boot recovery after a crash.

### Summaries

`summary` strings are engine-generated, human-readable, and lane-agnostic (e.g. `"scrape-1 finished in 10.2s"`). They are display text: their wording may change, and clients must never parse them. Machine-readable facts always travel in dedicated fields.

### Delivery semantics

Events are emitted after their transaction commits, so the stream never reports a state the database does not hold. If a connection drops between a commit and its broadcast, the event is not lost — it is replayed from the persistent transition log on reconnect via `Last-Event-ID`/`?since`. Consumers should treat event application as idempotent per id.

---

## 9. Route ownership and SPA coexistence

In production one server serves both the API and the dashboard SPA. The boundary is fixed:

- **The API owns exactly:** `/tasks` and everything under it, `/events`, and `/health`. These paths always behave as documented here and never serve HTML.
- **Every other GET** serves the SPA: static assets when the path matches a built file, otherwise `index.html` (client-side routing fallback).
- Non-GET requests outside the API paths are `404`.

The SPA's client-side routes are chosen to never collide with API paths: `/`, `/submit`, and `/task/:id` — **singular** `task`, deliberately distinct from the API's plural `/tasks`. Adding an API route outside `/tasks*`, `/events`, `/health` (or an SPA route inside them) is a breaking change to this contract.

In development the Vite dev server proxies `/tasks`, `/events`, and `/health` to the API process, so the same relative URLs work in both modes.

---

## 10. curl quickstart

Keys are printed once by `npm run seed`. Substitute yours.

```bash
BASE=http://localhost:3000
KEY=bb_9f2ce4a1b7d8036c5e12f409ab87cd3210fe6b54

# Liveness (no auth)
curl -s $BASE/health

# Submit a 10-second scrape job
curl -s -X POST $BASE/tasks \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"lane":"scrape","params":{"duration_ms":10000}}'

# Submit a job that will fail (auto-retries, then lands in failed)
curl -s -X POST $BASE/tasks \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"lane":"report","params":{"duration_ms":2000,"fail":true}}'

# List running scrape tasks
curl -s "$BASE/tasks?status=running&lane=scrape" -H "Authorization: Bearer $KEY"

# Fetch one task by handle
curl -s $BASE/tasks/scrape-1 -H "Authorization: Bearer $KEY"

# Watch the live event stream (curl can set headers; ?api_key= exists for browsers)
curl -N "$BASE/events?since=0" -H "Authorization: Bearer $KEY"

# Collect the result (side effect: marks collected, frees the handle)
curl -s $BASE/tasks/scrape-1/result -H "Authorization: Bearer $KEY"

# Cancel a queued or running task
curl -s -X POST $BASE/tasks/scrape-2/cancel -H "Authorization: Bearer $KEY"

# Operator-retry a failed task
curl -s -X POST $BASE/tasks/report-1/retry -H "Authorization: Bearer $KEY"

# Stable reference and full history by immutable id
curl -s $BASE/tasks/id/01981fa0-4b2d-7d31-9e5a-8c2f6b1d4e7a -H "Authorization: Bearer $KEY"
curl -s $BASE/tasks/id/01981fa0-4b2d-7d31-9e5a-8c2f6b1d4e7a/history -H "Authorization: Bearer $KEY"
```

---

## 11. Spec ambiguities and resolutions

Places where the assessment spec is silent, self-tensioned, or open to interpretation, and the call made in each case:

| # | Ambiguity | Resolution | Rationale |
|---|-----------|------------|-----------|
| 1 | Spec prose says "category"; the API contract and task object say `lane`. | `lane` everywhere — paths, bodies, task object, events, storage. "Category" is treated as prose synonym. | When prose and the machine-checked contract disagree, the contract wins; a mixed vocabulary would guarantee bugs at the boundary. |
| 2 | The spec's event vocabulary (`accepted`, `ready`, `failed`, `cancelled`) has no event for a task *starting*, retrying, or being collected — yet the dashboard must update live without polling. | Additive extension events `running`, `retrying`, `collected`. The spec four are untouched, byte-for-byte. | A live dashboard cannot show "running within about a second" (spec criterion 2) off a stream that never says running. Clients ignoring the extensions still see every terminal outcome correctly. |
| 3 | Handles recycle only on *collect or cancel*, and cancel is spec-limited to "a queued or running task" — so what releases a `failed` task's handle? | `failed` is collectable, exactly like `ready`: `GET /tasks/{handle}/result` is legal from either, flips `collected`, and releases the handle. Cancel stays byte-for-byte spec — legal from `queued`/`running` only. | The rejected alternative was extending cancel to `failed`, which deviates from the spec's own cancel constraint and is semantically wrong for work that has already stopped running. The spec is self-consistent read the other way: the handles section defines active as "queued, running, or finished-but-uncollected" — which only holds together if "finished" spans both `ready` and `failed`; success criterion 5 says a failed job "is not silently collected," implying collecting it is legitimate, just never automatic; and the dashboard section describes operators who "collect a finished result," not just a successful one. No platform disagrees: Celery's `result.get()` and Temporal's result fetch return a stored failure through the same call as a success, and Sidekiq's Dead set offers retry or delete/acknowledge — no platform "cancels" a job that already finished. See [ADR 0013](./decisions/0013-failed-tasks-are-collectable.md). |
| 4 | "Field names and shapes are fixed" — does fixed mean closed? | Fixed is read as: every listed field must exist with exactly the specified name, type, and semantics. Additive, documented fields are permitted: `id`, `attempts`, `max_attempts`, `seeded` on tasks; `task_id`, `at` on events; extra endpoints. | A closed reading would forbid exposing any identity that survives handle recycling, making stable dashboard links impossible. All additions are namespaced away from spec fields and badged. |
| 5 | `GET /tasks/{handle}/result` "fetches the result" — but is the body the bare result value or something richer? | The full task object with `result` populated and `collected: true`. | Self-describing (status, error, attempts travel with it), consistent with every other endpoint, and unambiguous for clients that hit an already-collected task. The bare value is one property access away. The GET-with-side-effect method is spec-fixed; after the first collect the endpoint is idempotent while the handle still resolves to the same task. |
| 6 | The spec names no HTTP status codes. | `201` for creation; `200` for reads and actions; `400` validation / `401` auth / `404` unresolvable / `409` illegal transition, with machine-readable codes per [§3](#3-errors). `409` carries `current_status`. | Standard REST semantics. The `409`-with-actual-status pattern turns every rejected transition into a resynchronization hint instead of a dead end. |
| 7 | The spec requires operator retry ("the operator decides when to retry") but lists no retry endpoint. | `POST /tasks/{handle}/retry`, extension, legal only from `failed`, resets the attempt budget. | The dashboard is required to be a pure API consumer, so every dashboard action must exist as an endpoint. Budget reset reflects that a human decision supersedes the exhausted automatic budget. |
| 8 | The spec mandates per-user API keys and a live event stream (SSE or WebSocket); we chose SSE ([ADR 0007](./decisions/0007-sse-over-websockets.md)), and browser `EventSource` cannot send an `Authorization` header (browser WebSocket clients cannot set arbitrary headers either). | `/events` — and only `/events` — additionally accepts `?api_key=`. | The two spec requirements are jointly unsatisfiable for browser SSE clients without one of: query-param auth, cookies, or a token handshake. The query param is the smallest mechanism, confined to the one endpoint that needs it. |
| 9 | What should `GET /tasks/{handle}` return after the task is collected or cancelled — the spec doesn't say whether a released handle still resolves. | Active holder first; otherwise the most recent former holder; otherwise `404`. Permanent access via `GET /tasks/id/{id}`. | Collecting a result should not instantly 404 the handle you just used — scripts routinely collect and re-read. Once the handle is re-leased the new task must win, so former-holder access is best-effort by design and `id` is the durable reference. |
| 10 | The spec fixes `type Worker = (job: Job) => Promise<WorkerResult>`, but also requires that a running worker actually stop on cancel; the signal must reach the worker somehow. | Additive second parameter: `Worker = (job, ctx: { signal: AbortSignal })`. A spec-shaped one-argument worker remains assignable and fully functional. | The two spec requirements are jointly unsatisfiable without delivering an abort channel; the addition is ignorable, documented, and badged (the worker contract in [`architecture.md`](./architecture.md), [ADR 0010](./decisions/0010-additive-api-extension-policy.md)). |
