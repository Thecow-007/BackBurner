# 0019. Infinite scroll over a "Load more" button

Status: Accepted — 2026-07-26

## Context

`frontend-brief.md` §4.2 specifies the register's pagination affordance as a **"Load more" button, shown when `next_cursor` is non-null**. The approved design page renders something different: the register's last row is a quiet mono line reading `loading more · 10 of 312` with a 10px spinning ring, and the design notes summarise the register as "infinite scroll, no pagination."

Both documents are binding, and they disagree. The doc map settles the general case — the frontend brief wins on behaviour, `ui-spec.md` wins on appearance — but pagination is genuinely both. A button versus a scroll sentinel is a different interaction, not a different skin on the same one.

The tiebreaker is which document was written later and with more knowledge. The frontend brief's §4.2 was written before the design pass, when the register's visual density was undecided; §11 of that same brief explicitly reserves "spacing, type, colour, iconography, chip/badge treatments" for the design pass, and describes itself as binding for routes, states, the action matrix and store discipline. The design pass then chose 34px rows and a deliberately dense register — a decision §11 authorised — and a `Load more` button sitting under 50 rows of that density reads as a foreign object in a way it would not have at a looser rhythm.

## Decision

The register loads the next page automatically when a sentinel element near the end of the list becomes visible, using `IntersectionObserver`. While that fetch is in flight the list's final row renders the design's mono line, `loading more · <loaded> of <total>`, where `<total>` is `counts.matching` from the server (ADR 0018) and `<loaded>` is the number of rows actually held. There is no `Load more` button anywhere in the application.

Everything else about pagination is unchanged and still exactly as the frontend brief and `api-contract.md` §7 specify: keyset pagination over the opaque `next_cursor`, the same filter and sort parameters resent with the cursor, page size 50, and the sentinel firing exactly one request at a time.

Two guardrails keep this from becoming the bad version of infinite scroll:

- **It is not a refresh.** The sentinel fires only when `next_cursor` is non-null and no page request is already in flight. It never re-reads a page already loaded, so it cannot become a polling loop by another name. Zero-polling (frontend-brief §5 rule 4) is untouched.
- **The count is sourced, never derived.** `<total>` is the server's `counts.matching`. Before counts land, or if the server omits them, the line reads `loading more` with no numbers rather than a total inferred from the pages loaded so far — that inference is precisely the invented state `frontend-brief.md` §6.5 forbids.

## Alternatives considered

- **Follow the brief and ship the button.** The safest reading of "docs are law", and it keeps a keyboard-only user's path obvious. Rejected because the design page is equally law and is the more recent, better-informed document on this exact surface; overriding it here would also mean overriding the register's density, which the brief itself delegated. The keyboard concern is addressed directly instead (see Consequences).
- **Both: auto-load on scroll, with a button as a fallback.** Rejected as the worst of both. Two affordances for one action is the kind of hedging that reads as indecision in a reviewed codebase, and the button would be dead UI for almost every user.
- **Load everything and drop pagination.** Rejected outright: the seed set alone is 300 tasks and a real deployment is unbounded. `api-contract.md` caps `limit` at 200 for the same reason.

## Consequences

- The register gains an `IntersectionObserver` and a sentinel row; `loadMore()` on the store already existed and is unchanged, so the store's read discipline is not touched.
- **Keyboard and assistive-tech users are not stranded by a scroll-only affordance.** Tabbing through the last row moves focus to the sentinel, which is focusable and announces the remaining count; reaching it triggers the same load. This is the one place the implementation adds something the design page does not draw, and it is deliberate — an affordance that only exists for a mouse wheel would fail `ui-spec.md` §4.
- This is a departure from `frontend-brief.md` §4.2 and is flagged as one. `docs/ui-spec.md` §7 records it alongside the other design-gap resolutions so a reader hitting the brief's "Load more" sentence is pointed here rather than assuming the implementation drifted.
- If the counts endpoint is ever removed, the "of N" clause degrades to nothing rather than to a guess. That is the intended failure mode.
