# 0025. Resizable sidebar and detail pane, bounded in CSS

Status: Accepted — 2026-07-26

## Context

`ui-spec.md` §2 fixes the sidebar at 230px and the detail pane at 446px. Both numbers came from the design page and both are good defaults, but they are the same on a 1280px laptop and on a 2560px monitor — and the register, which is the screen an operator actually reads, is whatever is left over. On the laptop that leaves 603px, which [ADR 0024](./0024-collected-as-a-first-class-column.md) already showed is too narrow for the register's full column set; on the monitor it leaves 1884px of mostly whitespace beside a detail pane that has more to say than 446px lets it.

Driving the running UI made the second case concrete: reading a long `error.reason` or a twelve-node timeline in a 446px column is a scroll, and the space to fix it was sitting unused two panes over.

The obvious implementation — a pointer drag that writes a pixel width — has an obvious failure mode, and it is the reason this needs a record rather than a commit. A width is stored per browser, not per window. Drag the detail pane to 1100px on a monitor, open the laptop, and the register is 100px wide. The naive fix is a resize listener that re-clamps on every viewport change, which contradicts the rule the shell has held since it was written: **no layout decision in this SPA reads the viewport width.** That rule is what keeps the sidebar from remounting, the panes from refetching, and the breakpoints from having two sources of truth.

## Decision

Both panes get a drag handle, and the stored width is spent inside a `clamp()` whose upper bound is a viewport fraction:

```css
.sidebar    { width: clamp(200px, var(--sidebar-w), 30vw); }
.detailPane { width: clamp(360px, var(--detail-w), 50vw); }
```

That single expression is the whole reason to do it this way. The caps — sidebar never more than 30% of the viewport, detail never more than 50% — enforce themselves in the style engine, re-evaluating on every viewport change with **no resize listener and no clamping logic in JavaScript**. A width dragged on a large monitor cannot swallow a small one: it is silently held at 30vw/50vw until the window is wide enough to honour it, and then honoured exactly. The token defaults (`--sidebar-w: 230px`, `--detail-w: 446px`) are unchanged and are what a pane falls back to when nothing has been dragged.

The floors are what each pane must hold: 200px for the sidebar's wordmark, counts and identity chip; 360px for the detail pane's duration readout and timeline.

Each handle is available only where its pane is a pane. The sidebar handle appears from 900px, where the sidebar is a column rather than a drawer; the detail handle from 1280px and only with a task selected, where the detail is a pane rather than a full-screen replacement. Both are media-query decisions, so the set of resizable things is still something the stylesheet knows and JavaScript does not.

The handle is a control, not a decoration. It is the panel hairline — one pixel, `--line`, hovering to `--line-strong` — with the hit area widened by a transparent pseudo-element, so the target is comfortable without a grab bar appearing in a design that has none. It carries `role="separator"`, `aria-orientation="vertical"`, an accessible name, and the full `aria-valuenow`/`valuemin`/`valuemax` set; it is reachable by Tab, moves in 16px steps with ArrowLeft/ArrowRight, jumps to its limits with Home/End, and resets to the token default on double-click. It listens for **pointer** events, so a trackpad, a stylus and a touchscreen all work, and it captures the pointer so a fast drag cannot escape the 1px target. Nothing transitions during a drag: the two-animation rule (`ui-spec.md` §1.3) stands, and a transitioned drag lags behind the pointer anyway.

Widths persist in `localStorage` through `lib/storage.ts`, beside the per-lane duration defaults, and are written once per drag rather than once per frame.

The one place JavaScript reads the viewport is `aria-valuemax`, which needs a number and cannot be given a `vw`. It is measured at the moment of an interaction — pointer-down, or a key press — and never on a timer or a listener. If the window is resized without touching the handle, that one ARIA value is briefly stale while the rendered width remains correct, because CSS re-clamps regardless. That is the honest trade and it is documented at the call site.

## Alternatives considered

- **Leave the widths fixed.** No new control, no new state, and the design page's exact numbers. Rejected because the numbers are right for one viewport and the product is used on several, and because the register's own column set — the thing ADR 0024 spent a migration and a container-query tier list on — is decided by leftover width. Making the leftover adjustable is the cheapest way to make those tiers reachable.
- **Clamp in JavaScript with a `resize` listener.** The conventional implementation, and it would work. Rejected because it puts a second source of truth for layout beside the media queries, and because "no width listener" is not a stylistic preference here: the shell's mount-once, refetch-never behaviour depends on the pane count being a pure CSS decision. A listener that only clamps today is a listener that decides a breakpoint next year.
- **Store the width as a percentage instead of pixels.** Self-scaling, so no cap is needed. Rejected because a drag is a pixel gesture and the user is choosing a pane size, not a ratio: a sidebar set to a comfortable 260px on a laptop would become 390px on a monitor, which is not what "I made this a bit wider" meant. The clamp gives ratio-like safety while keeping the chosen size.
- **A `ResizeObserver` on each pane to feed the ARIA values exactly.** Removes the one stale number. Rejected as disproportionate: it adds an observer per pane and a render per frame during a drag, to correct an attribute whose consumer re-reads it on the next interaction anyway.
- **Collapse-to-icons instead of free resize.** A common pattern and a real answer to "the sidebar is too wide". Rejected because the sidebar's content is counts, and a collapsed sidebar hides exactly the numbers it exists to show; the operator who wants more register wants a *narrower* sidebar, not an absent one.
- **Persist the widths per breakpoint.** Would let a laptop and a monitor each remember their own layout. Rejected as speculative: two stored numbers become six, the clamp already prevents the harm, and nobody has asked for it.

## Consequences

- `AppShell.tsx` gains a `ResizeHandle` component and two pieces of state; `AppShell.module.css` gains the handle rules and two `clamp()` expressions. `theme/tokens.css` is untouched — the defaults were already there and keep their values.
- The sidebar and the detail pane no longer draw their own dividing hairline; the handle *is* that hairline. This is why the sidebar's `border-right` is cleared in the shell's own stylesheet: two rules side by side would read as a 2px border.
- **The register's container queries react on their own.** They already key off the register pane's own inline size rather than the window's (`ui-spec.md` §2.1), so dragging the sidebar narrower moves the register through its track sets with no additional wiring. That is the point of the change.
- `lib/storage.ts` gains a third stored key, `backburner.paneWidths`. Like the others it degrades to in-memory in a locked-down browser rather than throwing.
- A stored width from a wide monitor is *held*, not *rewritten*, on a narrow one. Opening the laptop shows a 30vw sidebar; opening the monitor again restores the dragged width exactly. Only a double-click discards it.
- `aria-valuemax` can lag a bare window resize until the next interaction with that handle. The rendered width cannot.
