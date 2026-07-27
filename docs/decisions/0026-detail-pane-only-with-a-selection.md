# 0026. The register spans the full width when nothing is selected

Status: Accepted — 2026-07-26

## Context

`ui-spec.md` §2 gives the three-pane layout a persistent detail pane: at ≥1280px the pane is always on screen, and with no task selected it renders a resting state — a dim ember-bar glyph and the line "Select a task to see its parameters, full history and the actions its status permits." (§3.11).

Two things are wrong with that, and only one of them is aesthetic.

The aesthetic one is that a 446px panel holding a sentence is the largest element on the screen doing the least work. The repo owner, driving the built dashboard, said so plainly.

The structural one is that it costs the register real columns. [ADR 0024](./0024-collected-as-a-first-class-column.md) made the register's track set a function of the *pane's* width via container queries, and measured the consequence: at a 1280px viewport the register pane is 603px, because the 230px sidebar and the 446px detail pane come out first. 603px is the narrowest tier — five tracks — so LANE, ATTEMPTS and COLLECTED are all switched off. At an ordinary laptop width, the register's full eight-track layout was unreachable in the layout it was designed for, and the thing standing in its way was a panel with nothing in it.

`ui-spec.md` §2 also uses the always-present pane to justify a second decision: "There is **no ACTION column in three-pane view** — the detail pane is always present." If the premise goes, that sentence has to be re-argued rather than quietly left standing.

## Decision

With no task selected the detail pane is not shown, and the register fills the row. Selecting a row brings the pane in; navigating back to `/` gives the width back.

The mechanism does not change: **both panes stay mounted and the pane count stays a pure CSS decision.** The shell root already carries `data-detail` (true exactly when the URL is `/task/:id`) and `data-submit`, and the base stylesheet already had `.shell[data-detail="true"] .detailPane { display: flex }` for the one- and two-pane layouts. The change is to stop the ≥1280px block from re-enabling that pane unconditionally, so one declaration now means "not selected → not shown" at every pane count. No width listener is introduced, and the shell still never remounts a pane on a route change.

The resting state is **retired**, in the implementation and in the spec. A state that nothing can reach is worse than no state: it is dead code that reads as a feature, and the next person to touch the shell has to work out why it never appears. Its copy is deleted from `ui-spec.md` §3.11 rather than left as a curiosity.

**Inline row actions still do not return at three panes.** The original justification is now false, so here is the real one: selecting a row is a single click and yields the full, labelled action bar with the confirmations the matrix requires — and collect is irreversible. Making a deliberate selection before an irreversible act is a feature, not a tax. A hover-revealed collect button at the end of a 34px row, in a list the operator is scrolling, is precisely the mis-fire `ui-spec.md` §3.8 already guards against on mobile by making every list-initiated action confirm first. The three-pane register keeps no ACTION column because the actions belong where the task is, not because a panel happens to be on screen. `ui-spec.md` §2 now says that.

## Alternatives considered

- **Keep the pane and shrink it when empty.** Preserves the layout's rhythm and avoids the register visibly reflowing on selection. Rejected because it is the same problem with a smaller number: any always-present width is width the register does not get, and the reflow is not a cost — it is the feedback that a selection happened.
- **Keep the resting pane and make the register's tracks depend on the window instead of the pane.** Would restore the eight-track register at 1280px without touching the layout. Rejected outright: ADR 0024 rejected window-width tiers for a reason that has not changed — at 1280px the register is 603px and at 1279px it is 1049px, so the window cannot answer the question the tracks are asking.
- **Show something useful in the resting pane** — the newest failure, aggregate counts, a getting-started card. Rejected because every candidate is either a number the sidebar already shows or a claim the API does not support, and because "fill the empty panel" is how an operations tool acquires a dashboard it did not need. `ui-spec.md` §5 already puts charts and metrics tiles out of scope.
- **Let the operator pin the pane open.** A preference, and a small one. Rejected as premature: the owner's complaint was that the empty pane is wrong, not that its presence should be configurable. [ADR 0025](./0025-resizable-sidebar-and-detail-panes.md) already gives the operator control over how much room the pane takes when it *is* open.
- **Bring inline row actions back now that the register is wide.** Tempting, because the width is there. Rejected on the grounds above: collect frees a handle and cannot be undone, and a hover-revealed control on a scrolling list is the worst place to put an irreversible action. Nothing about a wider register makes that safer.

## Consequences

- **The eight-track register is reachable at ordinary laptop widths.** At a 1280px viewport with nothing selected the register pane is ~1049px — comfortably past the 820px threshold — so HANDLE, STATUS, COLLECTED, LANE, ATTEMPTS, CREATED and NOTE all render. That is the win, and it is why this ADR sits beside ADR 0024 rather than inside it.
- Selecting a row narrows the register and can move it down a track tier; deselecting widens it again. The transition is a container-query re-evaluation, which is exactly what ADR 0024 built.
- `ui-spec.md` changes in three places: §2's action-column justification is rewritten, §2.1's note about which viewports reach the five-track set is updated, and §3.11 loses the "Detail pane, nothing selected" row.
- `AppShell` no longer imports `EmptyState` for its own use, and `RESTING_COPY` is gone. `App.tsx` still passes `detail={null}` when nothing is selected; the meaning of `null` is now "do not show the pane" rather than "show the resting state".
- At one and two panes nothing changes at all — the pane was already only shown on `/task/:id` there.
