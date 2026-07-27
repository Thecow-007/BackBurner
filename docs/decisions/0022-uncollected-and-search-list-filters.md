# 0022. The `uncollected` and `q` list filters

Status: Accepted — 2026-07-26

## Context

`GET /tasks` has two filters it needs and does not have, and both were exposed by driving the finished dashboard rather than by reading the contract.

The first is a gap between a number and a view. `counts.uncollected` — "how many finished results are waiting to be collected" — is the register's most actionable number and, in the dashboard, a clickable badge. Clicking it had nowhere to go. `?status=ready` is wrong (it includes collected results and excludes failed ones), and `?status=ready&collected=false` does not exist. A number that opens nothing is a dead end; worse, any filter approximating it by hand is a second definition of "uncollected" that can drift from the first. [ui-spec.md](../ui-spec.md) §3.10 states the rule directly: the badge and the view it opens must be the same predicate.

The second is search. The register is a few hundred rows and unbounded in production, paginated at 50. An operator who knows a handle — `scrape-12` — or is holding a task id from a log line has no way to reach that row except by scrolling until it appears. Handles also recycle ([ADR 0002](./0002-uuidv7-primary-key-handle-as-lease.md)), so "the task called `report-1`" is frequently ambiguous: a live one and one or more released former holders can all answer to it honestly.

## Decision

Two additive **[EXTENSION]** query parameters on `GET /tasks`, parsed once in the engine's shared `filters.ts` and therefore honoured identically by the listing and by the counts.

**`?uncollected=true`.** The only accepted value is the literal string `true`; `false`, `1`, `yes`, and the empty string are all `400 invalid_params`, per §7's standing rule that an invalid value is never silently ignored or clamped. A client that wants the filter off omits the parameter. When present the read is restricted to `status IN ('ready','failed') AND collected = false` — not a predicate *equivalent to* the one behind `counts.uncollected` but literally the same exported SQL constant, so the badge and the view can never disagree. It composes freely with `status`, `lane`, `from`, `to`, `sort`, `limit`, and `cursor`.

Its effect on the counts follows the bases already established by [ADR 0018](./0018-task-counts-on-list-response.md): `matching`, `status.*`, and `lane.*` respect it; `all` does not; `lanes` and `lane_defaults` do not. The one deliberately surprising row is `uncollected` the *count*, which ignores `uncollected` the *filter* — for exactly the reason `status.*` ignores `status`. It **is** that predicate. A badge that collapsed to itself the moment you clicked it would stop being a badge.

**`?q=`, a free-text lookup.** A string, 1–64 characters after trimming, case-insensitive. A task matches when its derived handle equals `q`, its id equals `q`, its handle starts with `q`, or its id starts with `q`. So `q=scrape` returns every scrape, and `q=scrape-1` returns `scrape-1`, `scrape-10`, `scrape-19`. Handles are never stored as text (architecture §5), so the comparison builds `lane || '-' || handle_num` in SQL; `%`, `_`, and `\` in `q` are escaped before they reach `LIKE`, so a search box cannot become a wildcard injection.

Three properties make `q` a different read from every other filter, and each is a decision:

1. **It is ranked, not sorted.** Exact handle-or-id matches first; then tasks that still hold their handle (`queued`/`running`, or `ready`/`failed` uncollected) ahead of released ones; then `created_at` descending, ties by `id` descending. The second tier exists because handles recycle: when a live `report-1` and a released former `report-1` both answer honestly, the live one is the one the operator meant.
2. **It is unpaginated.** `next_cursor` is always `null`. `limit` still caps the page (default 50, max 200), and `counts.matching` counts *all* q-matches under the other active filters — so a client can honestly render "showing 20 of 184 matches" without inferring the total from what it happens to hold.
3. **It refuses to guess.** `q` with `cursor`, or `q` with `sort`, is `400 invalid_params` with a message naming the conflict. Relevance and an explicit time order are two different orderings; silently applying one while the client asked for the other is a lie, and keyset pagination over a rank that is not a keyset is simply incorrect.

## Alternatives considered

- **Search client-side over the loaded pages.** No server work at all, and structurally wrong: the client holds one page of a paginated register, so "no results" would mean "not in the 50 rows I have scrolled past." A search box that silently searches a subset is worse than no search box — and a *count* derived from that subset is exactly the invented state [frontend-brief.md](../frontend-brief.md) §6.5 forbids. Loading every row to make it correct is the option ADR 0019 already rejected on the same grounds `limit` is capped at 200.
- **Make `q` paginate like every other filter.** Consistent, and it would require the rank to be expressible as a keyset — which it is not, because the top tier depends on an equality test against the query string and the second on a status predicate that changes as tasks are collected. A cursor over an unstable rank silently skips and duplicates rows. Capping the page and reporting the true total in `counts.matching` gives the client everything a cursor would have, without the incorrect resumption.
- **Let `sort` win over `q`, or `q` win over `sort`.** One fewer error path, and an arbitrary rule the client cannot see the effect of. §7 already rejects silent clamping for values; a silently discarded *parameter* is the same defect with a bigger blast radius.
- **Full-text search over params and error reasons (`tsvector`).** Genuinely useful, and a much larger surface: a new column or index, a query language to document, ranking semantics to define, and stemming behaviour to explain. The actual need is "take me to the row I can already name." Handle-and-id lookup answers it exactly; anything broader can be added later without changing this one.
- **A dedicated `GET /tasks/search` route.** Keeps `GET /tasks`'s semantics uniform, at the cost of a new path under a spec-adjacent namespace ([api-contract.md](../api-contract.md) §9), a second filter parser, and a second counts implementation — re-opening the very drift ADR 0018 removed by putting counts on the list.
- **Accept `?uncollected=false` as "no filter".** Friendlier to a form that always serialises its checkbox, and it makes an invalid-value rule into a special case. §7's rule is worth more than the convenience: every other parameter rejects what it does not understand, and a client that can send `false` can send `False` and `0` and expect them to mean something.

## Consequences

- `GET /tasks` gains two query parameters. No new route, no new response field, no change to any task object — a client that ignores both sees exactly today's behaviour.
- One append-only migration, `migrations/0003_search_and_uncollected_indexes.sql`, adds two indexes and no schema: a partial index on the uncollected predicate (which the filtered list can scan directly, in `created_at DESC` order), and an expression index over `lower(lane || '-' || handle_num::text)` with `text_pattern_ops` so the handle prefix scan is index-usable regardless of collation. Both statements are `IF NOT EXISTS`.
- `UNCOLLECTED_PREDICATE` is now a single exported SQL constant shared by the count and the filter. The agreement between them is structural: making them disagree requires editing one string.
- The engine's `ListFilters` grows two optional raw-string fields; validation stays in `filters.ts`, so `list()` and `counts()` cannot diverge on whether a request was even valid — including the `q`+`sort` and `q`+`cursor` rejections, which both calls raise identically.
- Two supplemental suites cover it: `list-search` (the matching set, LIKE-metacharacter escaping, user scoping, all three ranking tiers, the null cursor, composition with the other filters, and both 400s) and an extension of `counts-coherence` (row/count agreement under `uncollected` alone and combined with `status` and `lane`, plus the rejected values).
- `counts.matching` under `q` is a second full aggregate over the search predicate on every search request. It is one scan of the caller's rows, the same cost profile ADR 0018 already accepted for counts generally.
