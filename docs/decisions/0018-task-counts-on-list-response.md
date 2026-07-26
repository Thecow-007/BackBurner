# 0018. Task counts ride on the list response

Status: Accepted — 2026-07-26

## Context

The Phase 5 dashboard's primary navigation is a status list carrying per-status and per-lane totals, plus a "N to collect" header and an "N tasks" counter above an infinite-scroll list. No existing endpoint can serve those numbers: `GET /tasks` returns at most one page, and a total derived client-side from a page is invented state, barred by the honesty rule that governs every number in the UI ([frontend-brief.md](../frontend-brief.md) §6.5). [build-plan.md](../build-plan.md) therefore names task counts the one extension exempt from the post-green rule — a Phase 5 *dependency* — and leaves exactly one thing open: whether counts arrive as an additive object on `GET /tasks` or as a dedicated `GET /tasks/counts` route, "whichever proves cleaner."

Its acceptance criterion is the hard part, not the transport: counts must respect every active filter *except* the one dimension they enumerate, "so selecting a status shows exactly the number advertised; a stale or filter-incoherent count is a defect, not a rounding error."

## Decision

Counts ride as an additive `counts` object on the existing `GET /tasks` `200` envelope, beside `as_of` and `next_cursor`, badged **[EXTENSION]** in [api-contract.md](../api-contract.md) §6.2. No new route, no new spec surface — `GET /tasks` is a **[SPEC]** path and its task objects are untouched. The engine grows one method, `counts(userId, filters)`, returning `{ all, matching, uncollected, status, lane, lanes }`; the API calls it with the same parsed filters it already hands `list()` and adds the field to the envelope. As with every other read, `@backburner/api` runs no SQL of its own against `tasks` ([architecture.md](../architecture.md) §2).

Three sub-decisions carry the weight:

1. **Additive on the list, not a second route.** One round trip instead of two, and — decisively — a count and the list it opens are produced from the same request with the same parsed filters, so they cannot describe different filters. A separate route is two chances for the client to send a mismatched filter set, and two clocks.
2. **Each field has its own filter basis.** `all` respects only `from`/`to`; `matching` respects everything; `uncollected` and `status.*` respect `lane`/`from`/`to` but not `status`; `lane.*` respects `status`/`from`/`to` but not `lane`. This is not laxity, it is what the sidebar means: a per-status list whose numbers collapsed to `[0,0,N,0,0]` the moment you selected a status would be useless, and a grand total that shrank when you filtered would not be a grand total. `matching` is the one number that bites on every filter, because it is the one that labels the list. All of it is computed in a single query with `COUNT(*) FILTER (WHERE …)` aggregates over one scan, which is what makes `sum(status.*) === all` exact rather than approximately true.
3. **`lanes` comes from engine registration, not from the data.** `SELECT DISTINCT lane FROM tasks` answers "what has been submitted," and the submit form needs "what may be submitted." The two differ exactly when it matters most — a brand-new user with zero tasks would be shown a lane picker with no lanes in it, and a newly registered lane would stay invisible until someone had already used it. The lane list is engine configuration; it is reported as configuration.

## Alternatives considered

- **A dedicated `GET /tasks/counts` route.** Cacheable in isolation and arguably tidier, but it adds an API path under `/tasks*` (a contract change under [api-contract.md](../api-contract.md) §9), needs its own filter parsing and its own tests, costs a second round trip on every filter change, and re-opens the exact failure the acceptance criterion forbids: a count fetched under one filter set rendered above a list fetched under another.
- **Client-side counting from the loaded pages.** Free and instantly stale — it can only ever count what has been scrolled into memory. This is the invented-state failure the frontend brief names by name.
- **One number per status via five queries (or five round trips).** Simple to write, but the five results come from five snapshots, so `sum(status.*)` need not equal `all` and the sidebar can display a set of numbers that never simultaneously existed. The single-scan aggregate removes the possibility rather than making it unlikely.
- **Caching counts, or serving an approximate count above some threshold** (`reltuples`, a sampled estimate, "300+"). Cheap at scale, dishonest here: the register a reviewer sees is a few hundred rows, an exact count costs one indexed scan, and "about right" is precisely what the acceptance criterion rejects.
- **Omitting `counts` on cursor pages** (first page only). Saves an aggregate per page, but the infinite-scroll counter re-renders on every page and would have to remember a number from an older snapshot — stale by construction, and a client that starts mid-chain would have no total at all.

## Consequences

- `GET /tasks` grows one envelope field. Spec-shaped task objects, the endpoint path, and the status enum are untouched; a client written against the spec ignores the field per the compatibility rule ([api-contract.md](../api-contract.md) §1).
- Every `GET /tasks` now costs one extra aggregate query. It is one scan of the caller's rows through `tasks_list (user_id, created_at DESC)` — no new index, no new migration.
- The counts and the page are read back-to-back rather than in one snapshot, so a task committing between the two reads can be counted without appearing on the page. This is the same, already-accepted adjacency as `as_of` ([api-contract.md](../api-contract.md) §7): the *filter bases* are exact, the instant is adjacent. Making it atomic would require a repeatable-read transaction spanning both reads — real cost, for a millisecond of skew a live SSE stream corrects immediately.
- `status`/`from`/`to` are parsed by one shared engine module (`filters.ts`) used by both the listing and the counts, so the two cannot drift into reading a filter differently — the coherence rule is structural, not a comment.
- A supplemental suite (`counts-coherence`, [test-plan.md](../test-plan.md) §5.11) pins count/row agreement under each filter combination, including the zero-task user whose `lanes` must still be complete.
