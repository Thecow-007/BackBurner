# 0027. The search overlay reads the server, and keeps the results out of the store

Status: Accepted — 2026-07-26

## Context

The `⌘K` overlay was built as a jump-to, and it was honest about it: an exact handle-or-id lookup, resolved against the tasks the store happened to hold, with copy that said so twice — "This is an exact lookup — BackBurner has no text search" and "this field does not search error text or match prefixes."

That was true when it was written. [ADR 0022](./0022-uncollected-and-search-list-filters.md) made it false. `GET /tasks?q=` now matches handle and id by equality **or prefix**, case-insensitively, across the caller's whole register, and returns the rows already rank-ordered: exact matches first, then tasks that still hold their handle, then `created_at` descending. `counts.matching` reports the true total across all matches, and `next_cursor` is always `null`.

So the overlay was under-selling a capability the product has, while scanning a subset the user cannot see the edges of: "no results" meant "not in the 50 rows I have loaded", which is the failure mode ADR 0022's own alternatives section rejects. The repo owner asked for the real thing: `scrape` should list every scrape, and `scrape-1` should list `scrape-1`, `scrape-10`, `scrape-19`… with the exact match first.

Doing that means the SPA reads the server on a keystroke, and `frontend-brief.md` §5 rule 4 enumerates exactly four moments at which a read may happen. A fifth needs to be written down rather than smuggled in — the zero-polling rule is one of the two or three things this frontend is actually promising.

## Decision

**The overlay searches the server.** Typing issues `GET /tasks?q=<term>&limit=20`, debounced ~150ms, with the in-flight request aborted the moment the term changes. `sort` and `cursor` are never sent — both are a `400` in combination with `q` — and the response's order is rendered **verbatim**. There is no client-side re-sort: the ranking is the thing the request was made for, and its second tier (live handle-holders ahead of released former holders) is not derivable from a task object without re-implementing the server's rule.

**This is the fifth read moment, and `frontend-brief.md` §5 rule 4 now says five.** It belongs with filter and pagination changes rather than with polling: it is *user-driven*, it happens because a person typed, and it stops when they stop. There is no timer, no interval, no refetch-on-focus, and nothing about the register refreshes as a side effect. Zero-polling is untouched.

**The results never enter the store.** `store.search(term)` returns `{ tasks, matching }` and writes nothing — not `tasksById`, not `listOrder`, not `counts`, not `historyById`. The overlay holds the answer in local component state and discards it on close. Two things break if that discipline slips:

- `listOrder` is the server's answer to the *register's* filters and sort. Search hits are the server's answer to a different question, ranked by relevance. Merging them splices foreign rows into an order that is supposed to be a true answer to the filter bar.
- `counts` is maintained locally between snapshots (ADR 0018), and every field's basis is the *register's* filters. A search response's `counts.matching` is the size of the match set — a number on a completely different basis. Adopting it would make the sidebar and the register header disagree with the list they sit beside, which is the one thing `ui-spec.md` §3.10 says must never happen.

The store already had a rule for tasks it learns about out of band — the event-driven backfill — and this is deliberately not that. A backfill exists because an *event* arrived for a task the store must now track. A search hit is something the user looked at.

**Degradation is loud.** If the request fails, the overlay falls back to the old exact scan over loaded tasks and says plainly that the results are limited to what is loaded — in the degraded-connection treatment, because it is the same admission: what you are looking at may not be the whole truth. It does not silently show a shorter list.

**The jump half survives.** A well-formed UUID that the search did not return still offers "open by id", because an id is a valid route whether or not it matched: the detail screen resolves it and owns the 404. Navigation is always to `/task/{id}` and never by handle — handles recycle, so a link built from one comes to mean a different task later.

`ui-spec.md` §3.13, titled "Search = jump-to" and opening "There is no text-search endpoint", is rewritten. Every sentence in the overlay's copy that claimed there is no text search is deleted; the placeholder becomes `search handles or paste an id…`.

## Alternatives considered

- **Leave the overlay as an exact jump-to.** No new read, no new rule, and the copy stays true. Rejected because the copy is *not* true any more — the API grew the capability, and an interface that under-reports what the system can do fails the same honesty test as one that over-reports it.
- **Search client-side over `tasksById` with prefix matching.** No server read at all, so rule 4 never changes, and it would look identical for the first 50 rows. Rejected for the reason ADR 0022 gives: the store holds one filtered page of a paginated register, so the result set is a subset with an invisible boundary, and "showing 20 of 184" cannot be said at all. A search box that silently searches a subset is worse than no search box.
- **Merge search hits into the store so results render from one source.** Structurally tidier at the component level, and it would let a search hit stay live via SSE while the overlay is open. Rejected on the two grounds above; the cost lands on `listOrder` and `counts`, which are the exact things this app is most careful about. A hit that is *already* in the store keeps rendering live from it anyway, because the overlay renders task objects and the store's copy is the same task.
- **Search on Enter instead of as you type.** One read per search, no debounce, no aborts, and rule 4 arguably unchanged in spirit. Rejected because prefix search is only useful when you can see the set narrowing — `scrape` → `scrape-1` → `scrape-19` is a browsing gesture, and requiring Enter at each step turns it into three separate queries.
- **Cache results by term for the session.** Fewer requests when a user retypes. Rejected as an optimisation with a correctness cost: task statuses change, and a cached search would show a `running` chip on a task that finished a minute ago, in an overlay whose whole job is to take you to the current state of a task.
- **Re-rank client-side to fold in tasks the store holds but the server did not return.** Would make the overlay feel complete during a slow request. Rejected because it produces a list ordered by two different rules at once, and because a task the server did not return under `q` is a task that does not match `q`.

## Consequences

- `lib/api.ts` gains `searchTasks(q, { limit, signal })`, and `request()` learns to distinguish an `AbortError` from a network failure so a cancelled keystroke does not flash "Could not reach the server."
- `store.ts` gains `search(term, signal)` and one new line in its own header comment: five read moments, not four. `frontend-brief.md` §5 rule 4 says the same.
- `JumpTo.tsx` keeps everything that already worked — ⌘K/Ctrl+K, arrow-key navigation, the focus trap, Escape, navigation by id — and gains a debounce, an `AbortController`, a `showing N of M matches` line sourced from `counts.matching`, and a degraded state.
- The overlay now issues network requests while open. Debounced and aborted, a term typed at speed produces one request, not one per character.
- A unit test asserts that `search` leaves `tasksById`, `listOrder`, `counts` and `historyById` referentially unchanged, including when a hit shares an id with a loaded row. That is the invariant this ADR exists to protect, and it is cheap to keep pinned.
- `ui-spec.md` §3.13 no longer describes a capability the product does not have. It is still a jump-to; it is now also a search.
