# 0024. `collected` becomes a first-class column, and the register's tracks become container-driven

Status: Accepted — 2026-07-26

## Context

Two problems that look separate turn out to be one problem.

**The marker.** `ui-spec.md` §3.2 drew the collected marker as the word `collected` in mono 10px, `--text-dim`, under a dotted rule, tucked into the NOTE cell of the desktop row. On screen that put a grey annotation immediately beside the state note — and on a failed row, immediately beside `error.reason` in red. Two pieces of text in one cell, one of them the engine's own words, competing for a line that is 34px tall. The dimmest legal text tier was doing the work of a structural distinction: `collected` is not a comment on the note, it is a different fact about the task.

**The width.** `ui-spec.md` §2 budgeted the row grid against "760px available", which is what the register pane gets at roughly a 1440px window in three-pane layout. The pane is not 760px at the layout's own entry width. At exactly 1280px — the width at which the third pane appears at all — the 230px sidebar and the 446px detail pane leave the register 603px. The existing fixed tracks, six gaps and the right padding already came to 588px, so NOTE was left with about 16px of its 180px floor and the grid simply overflowed its container, clipping the error text the floor exists to protect. That was live before this change; adding a column would have made it worse.

So the marker cannot become a column without first fixing the budget, and the budget cannot be fixed by a viewport media query, because **the register pane's width is not a function of the window's width alone**. At a 1280px viewport the pane is 603px (three panes). At 1279px — one pixel narrower — the detail pane collapses into the register and the pane is 1049px. The same window width means two very different amounts of room depending on which layout won.

## Decision

### The marker is a violet chip in its own column

`collected` renders in the status-chip recipe — mono 11px, weight 600, padding 3×9, radius 999 — on a new token, `--collected: #a68cd6`, with `background: #a68cd616` and `border: 1px solid #a68cd63d`. The word is still never abbreviated. On a wide desktop register it occupies its own track, **COLLECTED**, immediately after STATUS; on the mobile card it sits on the chip line beside the status chip.

The hue is deliberately outside the five status colours **and** outside ember. `collected` is a **handle-lease state, not a status**: §3.1's "there is no sixth status" and §1.1's "ember is never a status" both still hold, and neither is bent here. The task's own status chip is untouched — same colour, same glyph, same word, still muted to `.72` — and the lease marker sits beside it as a visibly different kind of object. Borrowing `ready` green would have said the engine did something; borrowing ember would have broken a rule that exists precisely so orange never means "state".

### The tracks are chosen by the pane, not the window

`container-type: inline-size` on the register, `@container` for the steps, applied from 900px only — below that the register is stacked cards and has no grid. Four sets, each threshold the width at which NOTE would otherwise drop below its 180px floor plus ~12px for the list's scrollbar:

| Register pane | Tracks | Dropped |
|---|---|---|
| ≥ 820px | all eight | — |
| 760–819px | seven | LANE |
| 670–759px | six | LANE, ATTEMPTS |
| < 670px | five | LANE, ATTEMPTS, COLLECTED's own track |

Every fixed track was re-measured against real rendered content rather than re-estimated, which is where the room for a new column came from: STATUS 116 → 104 (the widest chip, `cancelled`, is 97), CREATED 96 → 72 (`365 d ago` is 65, the `CREATED ↓` header 66), LANE 70 → 56, ATTEMPTS 82 → 76 including its new 12px right padding. HANDLE stays at 132 — `report-100` plus the seed badge is 126, and the handle is the one thing on the row that may never be truncated.

**The drop order is from the column the row can best do without to the one it cannot.** LANE goes first because the lane *is* the handle's prefix: `scrape-1` says `scrape`. ATTEMPTS next, because the state note already carries the budget on the rows where attempts are live (`attempt 2 / 3 · worker claimed 14:32:07`, `budget exhausted · …`). COLLECTED's *track* goes last, and the chip itself is never dropped — it returns to the head of the NOTE cell, which is where §3.2 always put it.

The five-track set is reached by exactly one situation: three panes between a 1280px and a 1346px window. That is the layout in which the detail pane is on screen at all times, carrying lane, attempts and collected state in full, which is what makes shedding two derived columns there defensible rather than lossy. NOTE gets 216px in that set — against the ~104px it could actually render before this change.

### The eight-track row aligns to the seven-span header without touching `Register.tsx`

`Register.tsx` is not modified. Two techniques do it, neither duplicating DOM:

- The header's COLLECTED label is a `::before` on the header line, placed at track 4 explicitly. The seven spans are placed explicitly too, and the trailing ones count back from the end (`grid-column: -2 / -1` is always the last track), so one set of rules is correct for all four sets and no cell can shuffle into a neighbour's column when a column disappears.
- The row's collected chip stays a child of the NOTE cell in the markup — the one place it also needs to be able to sit — and the NOTE cell switches to `display: contents` wherever the COLLECTED track exists, so the chip and the note text become two grid items from one wrapper.

Both read the same inherited `--register-tracks`, so "header and rows share identical tracks and gap" (§2) remains enforced by construction. Every cell is pinned to `grid-row: 1`: auto-placement drops to a new row whenever an item's explicit column sits behind the placement cursor, and the collected chip's column is behind the cells that precede it in the markup, so without that pin the chip would silently start a second grid row inside a 34px row.

## Alternatives considered

- **Keep the marker in the NOTE cell and just give it the chip treatment.** The cheapest change, and it does fix the "competing with error text" complaint by making the two visually distinct. Rejected because it leaves the marker's *meaning* structural and its *position* incidental: whether a handle has been released is a property of the task, scannable down a column, not an aside on a note. It is also what the narrowest set falls back to, so the behaviour still exists — as a degradation, not as the design.
- **Reuse a status colour, or ember, for the chip.** Rejected on the two rules this record refuses to bend. `ready` green would make an operator acknowledgement look like an engine transition; ember would put brand orange in the task table, which §1.1 forbids in as many words. A hue that belongs to neither vocabulary is the only one that can carry a lease state without lying about what kind of thing it is.
- **A sixth status chip, `collected`, replacing the status chip on collected tasks.** Rejected outright: the API's status enum has five values, and inventing a sixth on screen is the invented state `frontend-brief.md` §6.5 forbids. It would also destroy real information — `ready · collected` and `failed · collected` are different situations and must stay legible as such.
- **Viewport media queries encoding the pane arithmetic** (`(min-width: 1497px), (min-width: 1060px) and (max-width: 1279.98px)`). Correct, and with no containment side effects to think about. Rejected because it hard-codes the sidebar and detail widths into a stylesheet that does not own them: change `--detail-w` or the pane rules in `AppShell` and the register's columns would be wrong with nothing to catch it. The container query asks the pane directly and cannot fall out of date.
- **Fold COLLECTED "beside the status chip" at narrow widths instead of dropping the track.** This was the obvious fold and it does not pay. The status cell would have to hold a 97px chip, a 6px gap and a 79px chip — 182px — against 104 + 12 + 84 = 200px for a dedicated track. It saves 18px, which is not a fold, it is a rounding error. The NOTE cell is the only place the chip can go that costs nothing.
- **Shrink the detail pane so the register gets more room at 1280px.** `--detail-w` is a token this stylesheet could technically change. Rejected: 446px is the approved design's value, `ui-spec.md` §2 is normative for it, and re-cutting an approved layout to win a column is not a trade this decision is entitled to make.
- **Let NOTE fall below 180px at the narrowest widths and keep all seven original columns.** Rejected because it is the defect being fixed. `ui-spec.md` §2 has said since the design pass that NOTE "must never ellipse below ~180px" — it carries `error.reason`, and never truncating an engine error is the product's first rule (§0). Given a 603px pane, seven columns and a readable note cannot both exist; the note wins.

## Consequences

- **At a 1280px window the register shows five tracks, not eight.** Handle, status, created, note, and the collected chip inline. This is a deliberate, arithmetic outcome and the most likely thing to surprise a reader of this record: the full eight tracks need an 820px pane, which three panes reach at a 1497px window and two panes reach at 1050px. The upside is that at 1280px NOTE is readable for the first time.
- Three ordinary desktop widths now render three different column counts. That is what a container query is for, but it does mean a screenshot of the register is only meaningful with its pane width attached — hence the table in §2.1.
- `theme/tokens.css` gains three values (`--collected` and its two chip derivations) and remains the only file in the SPA where a colour literal appears. `#a68cd6` clears 6.8:1 on `--bg-app` and 6.6:1 on `--bg-raised`, so it meets the §1.1 contrast floor without adding a dimmer tier.
- The header's COLLECTED label is generated content, so it is exposed to assistive technology in DOM order rather than in visual order. The register is not a `<table>` and its header cells are not programmatically associated with row cells in any case; the row's own chip carries the word `collected` verbatim, which is what a screen reader actually reads. Should the header ever become a real table, the label should move into the markup.
- `TaskRow.module.css` decides no breakpoints. Every tier lives in `Register.module.css` and travels as inherited custom properties (`--register-tracks`, `--register-lane`, `--register-attempts`, `--register-collected`, `--register-note`, `--register-attempts-pad`), so there is exactly one place a track set can be wrong.
- `container-type: inline-size` was checked against the overlays rendered inside the register — the jump-to palette, the confirm sheet, the filter sheet, all `position: fixed; inset: 0`. Chrome does not make a size-query container a containing block for fixed-position descendants, and all three still span the viewport. This is worth knowing before containment is added anywhere else in the shell, because the reverse would be a silent, layout-only regression.
