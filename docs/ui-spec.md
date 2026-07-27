# BackBurner — UI build spec

Implementation spec for `@backburner/web`. Pairs with `docs/frontend-brief.md` (functional truth: routes, store discipline, action matrix, data shapes) — **this document covers only what things look like and how they behave visually.** Where the two disagree, the frontend brief wins on behaviour and this one wins on appearance.

Approved designs were authored in a design-chat export (`BackBurner UI - Final.dc.html`, plus the exploration history in `BackBurner Directions.dc.html` and the mark in `BackBurner Logo.dc.html`). That export was a transient working artifact and has been removed; **this document plus §6 below is now the complete and authoritative record of the approved design.** Reference ids used below: **5a** desktop three-pane, **5b** laptop two-pane, **5c** mobile (chosen), **5d** mobile states.

> **Provenance.** Transcribed verbatim from `BACKBURNER-UI-SPEC.md` in that export. §6 (Logo) and §7 (Design gaps resolved at build time) were added when the export was retired. A stale palette line in the export's own `CLAUDE.md` — which listed `running #ff5a1f`, `ready #7fd1b9`, `cancelled #6d5c53` — contradicted §1.1 below, contradicted its own "ember is never a status" rule, and contradicted the rendered design page. §1.1 is correct and authoritative; that line is discarded.

---

## 0 · The rule underneath everything

The product's pitch is honesty about system state. Never render a number you cannot source from the API, never render a status the engine did not announce, never truncate an error, never imply progress the engine cannot know. Elapsed-time counters only, always labelled as elapsed. No progress bars anywhere, ever.

Second rule: **the interface never claims an action succeeded before the confirming SSE event arrives.** Every mutating control is pending from press until that event lands — not until the HTTP response returns.

---

## 1 · Tokens

### 1.1 Colour

Dark only. There is no light theme and none is planned.

```
Surfaces
--bg-app        #0f0b09   page / register ground
--bg-panel      #120d0a   sidebar, detail pane, cards
--bg-raised     #16100d   header bars, JSON blocks, hover fill
--bg-group      #140e0b   list group headers (LIVE, HISTORY)

Lines
--line          #2b1e18   panel borders, dividers
--line-quiet    #1d1512   row separators
--line-strong   #4a3830   active input borders, sheet top edge, dashed markers

Text
--text          #f5ece4   primary
--text-dim      #a08b7e   secondary / metadata      (≥4.5:1 on all surfaces)
--text-quiet    #9a8172   micro-labels, counts      (dimmest legal tier)
                #6b544a   RETIRED for text — hairlines/decoration only
--text-mono-body #c9b6a8  JSON payload bodies

Brand / action  (ember)
--ember         #ff5a1f   wordmark, primary button, degraded connection
--ember-hi      #ffb347   wordmark gradient top only
--on-ember      #170d08   text on ember fills

Status
queued          #9a8b80
running         #58a6ff   the only animated status
ready           #5fd08a
failed          #ff4438
cancelled       #8a7a72

Lease state     (NOT a status)
collected       #a68cd6   muted violet
```

**Ember is not a status.** It is permitted in exactly four places: the wordmark, the primary action button, the `Reconnecting — data may be behind` connection state, and the unread-notification badge (which the design draws in ember — it is an attention marker, not a status, and it never appears on a task). It appears **nowhere in the task table and nowhere in the timeline**. Running-orange beside failed-red made a healthy screen read as an alarming one; that is why running is blue.

**Collected is not a status either.** `collected` is the handle-lease flag, and §3.1's "there is no sixth status" stands: the task keeps its own status chip, untouched, and the collected marker sits *beside* it. The violet is deliberately outside both the five status colours and ember, so a lease state can never be mistaken for something the engine announced. See ADR 0024.

Derived recipes (`S` = the status colour):
- Status chip, non-running: `background: S + '16'`, `border: 1px solid S + '3d'`, `color: S`.
- Status chip, running: solid `#58a6ff` fill, `#06131f` text, weight 700, pulse animation.
- Collected marker: the same chip recipe on the lease hue — `background: #a68cd616`, `border: 1px solid #a68cd63d`, `color: #a68cd6`.
- Timeline node dot: `background: S`, `box-shadow: 0 0 0 3px S+'22'` — **S is the status the transition moved *to***.
- Collected/terminal variants: same chip, `opacity: .72`; the duration readout `opacity: .6`.
- Destructive/retry button: `border #6b1f16`, `background #2a100c`, `color #ff7a55`.
- Collect (ready) button: `border #2f5c48`, `background #0f2019`, `color #5fd08a`. Ready is the one status whose action carries its own colour — collecting a *ready* result is the happy path and reads green (from 5d). Collect-on-failed uses the neutral button instead.

Contrast floor: every text colour above meets WCAG AA on every listed surface. Do not introduce a dimmer tier.

### 1.2 Type

- **Archivo** — UI prose: labels, buttons, headings, body copy, empty states.
- **IBM Plex Mono** — all data: handles, ids, timestamps, counts, statuses, lanes, JSON, timeline, log lines, error text.

If a value comes from the API, it is monospace. If it is something the interface says in its own voice, it is Archivo. Every column of digits gets `font-variant-numeric: tabular-nums`.

Scale actually used (px): micro-label 10 / 10.5 (letter-spacing .13–.16em, uppercase), mono meta 11–12, row body 12.5, UI body 13–13.5, button 13–15, row handle 13.5–17, detail handle 26–30, duration readout 26–34. Mobile minimum interactive text 14. Desktop hairline label minimum 10 with the tracking above.

### 1.3 Space, radius, motion

- Spacing scale: 4 / 6 / 8 / 10 / 12 / 14 / 16 / 18 / 20 / 22.
- Radius: 3 chips-as-buttons and inputs, 4 buttons, 5–6 panels, 999 status chips, 12–14 sheets and phone frames.
- Desktop row height 34 (density is a feature — do not loosen). Mobile card row 44–48 min.
- Motion: only two animations exist. `pulse` (opacity 1 → .45, 1.6s) on the running chip, on the connection dot, and on the degraded-state dot (faster, 0.8s). `spin` (1s) on the 10px infinite-scroll indicator ring. Everything else is static. Honour `prefers-reduced-motion: reduce` by disabling both.

---

## 2 · Layout and responsive rules

| Width | Panes | Detail lives |
|---|---|---|
| ≥ 1280px | three **while a task is selected**: sidebar 230 · register flex · detail 446. With nothing selected, two: sidebar 230 · register flex | right pane, present only when a row is selected; returning to `/` gives the register the width back |
| 900–1279px | two: sidebar 230 · register flex | selecting a task **replaces the register** with detail + a `← Register` affordance; sidebar never moves |
| < 900px | one | sidebar becomes a drawer; register becomes stacked cards; detail is a full screen |

The URL is always `/task/:id`, keyed by the immutable id, at every pane count. Handles recycle; a link must never come to mean a different task later.

**The detail pane is not shown when nothing is selected.** A 446px panel holding one sentence was the largest element on screen doing the least work, and it cost the register the columns §2.1 measures: at a 1280px viewport an always-present pane leaves the register 603px, its narrowest tier. Selecting a row brings the pane in. See [ADR 0026](./decisions/0026-detail-pane-only-with-a-selection.md).

There is **no ACTION column in three-pane view.** The reason is not that the detail pane is always present — it is not. It is that selecting a row is one click and yields the full, labelled action bar with the confirmations §3.8 requires, and **collect is irreversible**: making a deliberate selection before an irreversible act is a feature, not a tax. A hover-revealed collect button at the end of a 34px row, in a list the operator is scrolling, is exactly the mis-fire §3.8 already guards against on mobile. Inline row actions exist only at ≤ 2 panes (revealed on hover and keyboard focus in the desktop table; always visible on mobile cards).

**The sidebar and the detail pane are resizable** ([ADR 0025](./decisions/0025-resizable-sidebar-and-detail-panes.md)). Each has a drag handle on the edge it shares with the register — the panel hairline itself, one pixel, with the hit area widened by a transparent pseudo-element so the target is comfortable without a grab bar appearing. Limits: sidebar min 200px and never more than **30vw**; detail min 360px and never more than **50vw**. The width is spent inside `clamp(<min>, var(--…-w), <cap>vw)`, so the caps enforce themselves as the viewport changes — there is no resize listener anywhere in the SPA and no clamping logic in JavaScript, and a width dragged on a large monitor cannot swallow a small one. The sidebar handle exists from 900px (where the sidebar is a column rather than a drawer), the detail handle from 1280px and only with a task selected. Each is a real control: `role="separator"`, `aria-orientation="vertical"`, `aria-valuenow`/`valuemin`/`valuemax`, an accessible name, Tab-reachable, ±16px on ArrowLeft/ArrowRight, Home/End to the limits, double-click to reset. Pointer events, not mouse events. Nothing transitions during a drag — §1.3's two-animation rule stands. Widths persist in `localStorage`.

Wide content (JSON panels) scrolls inside its own container. The page never scrolls sideways.

### 2.1 Register row grid

Full set — gutter · HANDLE · STATUS · **COLLECTED** · LANE · ATTEMPTS · CREATED · NOTE:

`4px 132px 104px 84px 56px 76px 72px minmax(180px,1fr)` with `column-gap: 12px` and 16px right padding. **Header and rows must share identical tracks and gap.** NOTE carries error text and must never ellipse below ~180px, which is why it alone has a floor.

Every fixed track is measured content plus a few px: HANDLE 132 holds `report-100` (81) plus the seed badge (39) and their gap; STATUS 104 holds the widest chip, `cancelled` (97); COLLECTED 84 holds the `collected` chip (79); ATTEMPTS 76 holds its own header word (58) plus the 12px separation below; CREATED 72 holds `365 d ago` (65) and `CREATED ↓` (66). HANDLE is 132 rather than the design's 116 because 116 truncated `report-10`, and truncating the handle is not an option in a product whose central idea is the handle.

**The set is chosen by the pane's width, not the window's** — `container-type: inline-size` on the register, `@container` for the steps. The two are not related by one formula: at a 1280px viewport the register pane is 603px *with a task selected* (the 230 sidebar and the 446 detail come out first), while with nothing selected — or at 1279px, where the layout is two panes — it is ~1049px. The same window width is a cramped pane or a roomy one depending on which layout won and on whether a row is selected, so only the pane can answer. Containment is applied from 900px only, where the desktop grid exists at all.

The panes are also draggable (§2), which moves the register between tiers without any additional wiring: the container query re-evaluates on the pane's own inline size, whatever changed it.

| Register pane | Tracks | Dropped |
|---|---|---|
| ≥ 820px | all eight | — |
| 760–819px | seven | LANE |
| 670–759px | six | LANE, ATTEMPTS |
| < 670px | five | LANE, ATTEMPTS, and COLLECTED's own track — the chip folds back beside the note |

Each threshold is the width at which NOTE would otherwise fall below its 180px floor, plus ~12px for the list's scrollbar. The drop order runs from the column the row can best do without to the one it cannot: **LANE** first, because the lane *is* the handle's prefix (`scrape-1`); **ATTEMPTS** next, because the note already states the budget on the rows where attempts are in play; **COLLECTED's track** last, and the chip is never dropped — only relocated back into the NOTE cell. The five-track set is reached only **with a task selected**, by the three-pane layout between a 1280px and a 1346px viewport — precisely the case where the detail pane is on screen carrying lane, attempts and collected state in full. With nothing selected at those widths the register spans the row and takes all eight tracks ([ADR 0026](./decisions/0026-detail-pane-only-with-a-selection.md)); dragging the sidebar wider or the detail pane wider (§2) moves it back down the tiers, which is the same mechanism doing the same job.

A new column is budgeted against the pane, never added optimistically: eight tracks, seven gaps and the right padding need 812px before NOTE gets its floor.

The header line is seven `<span>`s and the eighth column is drawn by a `::before` on the header at an explicit track; the row's collected chip is lifted out of the NOTE cell by `display: contents`. Neither adds an element to the DOM, and both read the same `--register-tracks`, so the two can never disagree.

ATTEMPTS is right-aligned digits immediately before CREATED's left-aligned digits, so it carries 12px of extra right padding on top of the shared gap — declared once and consumed by both the header cell and the row cell.

### 2.2 The end of the list

The register's scroll container carries `clamp(180px, 40vh, 480px)` of bottom padding; at one pane that sits on top of the 86px of action-bar clearance and the safe-area inset. Without it the last row or two are pinned to the bottom edge, under the browser's own link-target tooltip, and a row that cannot be scrolled into clear view cannot be read.

---

## 3 · Components

### 3.1 Status chip — 5 variants
Status word always inside the chip, verbatim from the API, never paraphrased, never colour-alone. Leading glyph: queued `·` running `▸` ready `✓` failed `✕` cancelled `⊘`. Mono 11px, padding 3×9, radius 999. Running is the only variant that animates.

There is no sixth status. A collected task keeps its chip (at `.72` opacity) and gains the collected marker below.

### 3.2 Collected marker
The word `collected` in the status-chip recipe — mono 11px, weight 600, padding 3×9, radius 999 — on the lease hue (§1.1): `background: #a68cd616`, `border: 1px solid #a68cd63d`, `color: #a68cd6`. Never abbreviated: collected-vs-uncollected *is* the handle-lease concept.

It is a chip and not dim text because it earns a column of its own on desktop (§2.1) and because in the NOTE cell it was competing with error text for the same line. It is a **different hue from all five statuses and from ember** so that reading it as a sixth status is impossible; the task's own chip sits beside it, untouched.

Placement: beside the chip on detail, its own COLLECTED column on a wide desktop register, back in the NOTE cell on a narrow one, in the card's chip line on mobile.

### 3.3 Seed badge
`seed`, mono 9.5px, tracking .12em, `--text-dim` on `1px solid #33261f`, radius 2. Quiet by design: it marks synthetic history, it is not a warning.

### 3.4 Task row / card
Desktop: the grid above; gutter is a 3px `running`-blue rail on live rows only; hover fills `--bg-raised`. The collected chip takes the COLLECTED column where §2.1 grants one, and sits at the head of the NOTE cell where it does not. NOTE shows the first line of `error.reason` for failed rows in `#ff8a7a`, otherwise the state note in `--text-dim`. Queued rows show `—` in ATTEMPTS, never `0 / 3` — zero-of-three implies a spent attempt.

Mobile card (5c): line 1 handle (mono 15–17) + chip + collected marker + seed badge; line 2 the note (wraps, `text-wrap: pretty`, full reason for failures); right side one action button, min-height 44. Live rows keep the blue left rail and a faint blue wash `linear-gradient(90deg, rgba(88,166,255,.10), transparent 55%)`.

### 3.5 Timeline — the best component; do not redesign
Vertical rail, grouped by attempt. Group rule: `ATTEMPT 2 OF 3` on the left, hairline, per-attempt duration on the right (`11.7s`). Nodes: dot + event type (mono 12.5) + `from → to · meta`, timestamp right-aligned. Backoff waits render between groups as a 2px dashed vertical segment (`repeating-linear-gradient(180deg, #4a3830 0 4px, transparent 4px 8px)`) labelled `backoff 2.0s — waiting`.

**The rail is a line between events, so it stops at the final dot.** No stem is drawn below the last node of the last attempt group, and that node drops its trailing padding so the panel ends on its meta line. The exception is narrow and deliberate: a node that is merely last within an earlier group, or one with a backoff marker hanging below it, still has something to reach and keeps its stem.

Node timestamps read `HH:MM:SS` for a transition **from today** and gain their date otherwise — `04 Mar · 09:15:00`, or `30 Dec 2025 · 12:00:00` across a year boundary. A bare clock on a seeded row months old is not a timestamp, it is a riddle. The `<time datetime>` always carries the engine's exact instant regardless.

Keep the copy register exactly: `worker claimed`, `final attempt`, `budget exhausted · terminal`, `operator retry`, `automatic retry after restart`, `collected · handle released`. Precise, non-generic, never marketing.

### 3.6 Duration readout (detail header)
The slot **always holds a duration**, in the status colour, with a changing label — so the panel never jumps between states:

| Status | Reads | Action bar |
|---|---|---|
| queued | `0:14 WAITING` | Cancel |
| running | `5:20 ELAPSED` | Cancel |
| ready | `9.8s TOTAL` | Collect result |
| ready · collected | same, muted | none — terminal; result JSON shown |
| failed | `31.6s ACROSS 3 ATTEMPTS` | Retry · Collect / acknowledge |
| failed · collected | same, muted | none — error stays visible |
| cancelled | `2:04 BEFORE CANCEL` | none — terminal |

Terminal states replace the buttons with the mono line `terminal · view only` / `terminal · handle released`.

### 3.7 Buttons and pending states
Primary = ember fill (`New task`, `Submit`, the gate's `Connect`). Secondary = `1px solid #3a2c25`, transparent, `--text`. Retry = the red recipe. Collect-on-ready = the green recipe.

Pending is a **text change with a dashed border**, never a spinner alone: `Cancelling…` `Retrying…` `Collecting…` `Submitting…`. Disabled from press until the confirming event (`cancelled` / `retrying` / `collected` / `accepted`) applies to the store. After 10s of silence the label becomes `Waiting for confirmation…` and the client forces a resync. Convey with `aria-disabled` + the text, not opacity alone.

### 3.8 Confirmations
Desktop: inline confirm card inside the panel (`#16100d`, `1px solid #4a3830`), question in Archivo 13.5 with the handle in mono, two buttons right-aligned (`Keep running` / `Cancel task`).

**Mobile: every action initiated from the list view confirms first** — collect, cancel and retry alike — as a bottom sheet, so a thumb never fires a mutation mid-scroll. Sheet: `#120d0a`, top edge `1px solid #4a3830`, radius 12 top corners, 40×4 grab handle, question, then two 48px buttons side by side (dismiss left, confirm right). Confirm copy names the task:
- Cancel — "Cancel `scrape-1`? A running worker will be stopped."
- Collect on ready — "Collect `scrape-9`? This releases its handle for reuse."
- Collect on failed — "Collect `report-2`? This archives the task, frees its handle, and makes Retry unavailable."
- Retry — "Retry `report-2`? It re-queues with a fresh attempt budget."

On the **detail** screen, Collect-on-ready and Retry may act immediately (the user is looking at the task); Cancel and Collect-on-failed always confirm.

### 3.9 Connection indicator (sidebar, all screens)
1. `LIVE · as of 15:07:42` — green dot (pulsing slowly), `1px solid #234036` on `#0d1613`. **Human clock, not the event cursor.**
2. `RECONNECTING…` — ember text on `#1b1208`, `1px solid #4a3218`, dot pulsing 1s.
3. `RECONNECTING / DATA MAY BE BEHIND` — solid ember fill, `--on-ember` text, two lines, fastest pulse. The loudest thing in the sidebar: this is the interface admitting the view may be wrong. On mobile it becomes a full-width bar directly under the header (5d).

### 3.10 Counts (sidebar, and the mobile chip rail)
Per-status and per-lane counts, mono, tabular. **A count must always match the list it opens**: counts respect every active filter except the one they represent. If the design ever shows a count next to a filter it does not respect, that is a bug in the design.

**Every count that names a filter is pressable.** The register toolbar's `N to collect · N running` line is two buttons, not prose: `to collect` applies `?uncollected=true`, `running` applies `?status=running`, and each toggles off on a second press. They read as pressable — hairline border on hover, filled when pressed — without becoming button shapes; one clickable number beside one inert one is what would read as a bug.

**`to collect` is a filter, not a status.** `?uncollected=true` is `status IN ('ready','failed') AND collected = false` — the exact predicate behind `counts.uncollected`, so the number and the list it opens can never disagree ([ADR 0022](./decisions/0022-uncollected-and-search-list-filters.md)). It spans two statuses plus the lease flag, so it is deliberately **outside** the STATUS group everywhere it appears and §3.1's "there is no sixth status" keeps reading true. It carries no status glyph, and the ready hue touches only its number.

Its filter bases, as amended in `api-contract.md` §6.2: `matching`, `status.*` and `lane.*` **respect** the uncollected filter; `all`, `lanes`, `lane_defaults` and **the `uncollected` count itself** ignore it — the count *is* that predicate, and a badge that collapsed to itself the moment you pressed it would stop being a badge.

Where it appears:

| Surface | Treatment |
|---|---|
| Sidebar | A dedicated full-width row between the nav block and the STATUS group, hairlined above and below, reading `to collect` with `counts.uncollected` right-aligned in the ready hue. `aria-pressed`; re-press clears it. |
| Register toolbar (≥ 2 panes) | The first of the two pressable numbers described above. |
| Mobile chip rail | The **leading** chip, before `all` — at one pane it is the fastest route to the work waiting on the operator. |
| Mobile filter sheet | The same chip, leading the STATUS section, at the sheet's 44px touch size. |

At one pane the counts survive as a horizontally scrolling chip rail above the list, with a right-edge fade (`linear-gradient(90deg, transparent, --bg-app 70%)`) so it reads as scrollable.

### 3.11 Empty, error and resting states
- **No tasks yet** — heading `No tasks yet`, one line of prose, ember `Submit your first task`.
- **No tasks match these filters** — distinct copy, the active filters echoed in mono, secondary `Clear filters`. Must not look like the above; one is a new key, the other a filter mistake.
- **Snapshot failed** — red-railed panel, the envelope `message` verbatim in mono, `Retry` button. Never a blank pane.
- **Loading** — skeleton rows (3 bars per row, `#241a15` / `#1d1512`), one per expected row. No spinner, no layout shift. Shown on first snapshot and on every filter change.

There is **no resting detail-pane state**. An earlier version of this section specified one — a dim ember bar glyph over "Select a task to see its parameters, full history and the actions its status permits." — for the three-pane layout. With nothing selected the pane is no longer shown at all (§2), so that state is unreachable and its copy is retired rather than left as a state nothing can produce. See [ADR 0026](./decisions/0026-detail-pane-only-with-a-selection.md).

### 3.12 JSON panels
`#16100d` on `1px solid #2b1e18`, radius 4, mono 12/1.65–1.7, `--text-mono-body`, `white-space: pre`. Header line: micro-label left, `copy JSON` right. Collapsible where long. Params always shown; result only when collected; error **never** truncated (`white-space: pre-wrap; word-break: break-word`).

### 3.13 Search
A real partial search over **handle and id**, served by `GET /tasks?q=` ([ADR 0022](./decisions/0022-uncollected-and-search-list-filters.md), [ADR 0027](./decisions/0027-search-overlay-reads-the-server.md)). Placeholder `search handles or paste an id…`, `⌘K` badge, the familiar overlay (results list, `↑↓ move · ↵ open · esc close`).

- Matching is equality **or prefix**, case-insensitive, on handle and id. `scrape` lists every scrape; `scrape-1` lists `scrape-1`, `scrape-10`, `scrape-19`… **Never** error text, params or result payloads — the endpoint does not match those and the copy must not imply it does.
- **The server ranks; the client does not re-sort.** Exact matches first, then tasks that still hold their handle (queued/running, or ready/failed uncollected) ahead of released former holders, then `created_at` descending. The order that arrives is the order that renders.
- Typing issues the read, debounced ~150 ms, with the in-flight request aborted when the term changes. A 10px spinning ring (§1.3's `spin`, the only one) sits in the field while a request is out.
- When the response is truncated, one mono line above the results: `showing N of M matches`, where M is `counts.matching` — the whole match set. Absent rather than approximate when M is unknown.
- **Still a jump-to.** A well-formed UUID the search did not return keeps its `open by id` row: an id is a valid route whether or not it matched, and the detail screen owns the 404. Enter always navigates to `/task/:id`, never by handle — handles recycle.
- **Degraded, never silent.** If the request fails, the overlay falls back to an exact scan of the loaded tasks and says so in the degraded-connection treatment (`--ember` on `--conn-reconnecting-bg`): "Search is unavailable right now, so these are exact matches among the tasks already loaded — not the whole register."

Nothing in this overlay writes to the store. Results live in the overlay for as long as it is open (ADR 0027).

### 3.14 Sidebar inventory
Wordmark → connection indicator → nav (`Task register` with total, `Submit task`, `Notifications` with unread badge) → **`to collect` filter row** → STATUS counts → LANES counts → footer identity chip (`daniel · bb_9f2c…6b54`) + `change key`.

The `to collect` row is a band of its own between the nav block and the STATUS group, hairlined on both sides, full width, `aria-pressed`, toggling on re-press. It is **not inside the STATUS group**, because `uncollected` is not a status (§3.1, §3.10). Its ready-hued dot sits in the same 12px glyph column the status rows use, so the three blocks share one left edge; the ready hue also carries the count, and nothing else.

**No Account entry and no Notification rules entry** — there is no account system and webhooks are unbuilt. The footer chip is the entire account surface. Lanes render as a flat list up to 6, then become a filterable multi-select dropdown with counts; no explanatory copy about the switch is shown to users.

**Mobile drawer** (the `☰` beside New task): the sidebar minus the status counts, which already live in the chip rail above the list. Slides from the left, 300px wide, scrim `rgba(10,6,4,.72)`, close `✕` in the header. Contents in order: wordmark + connection state → the three nav destinations (52px rows) → LANES as 48px checkbox rows with counts → footer identity chip and a 48px `Change key` row. Traps focus; Escape and scrim-tap close it.

---

## 4 · Accessibility

- Touch targets ≥ 44×44 at mobile; ≥ 36 tall for desktop buttons.
- Status never by colour alone (word + glyph inside every chip).
- Landmarks: `header` / `nav` / `main`. The timeline is an ordered list. Actions are `<button>`, navigation is `<a>`.
- Toasts `aria-live="polite"`, failures `assertive`. The connection indicator announces changes. The task list is **not** a live region.
- Focus visible everywhere; sheets and drawers trap focus and restore it on close; Escape closes overlays.
- Inputs labelled, errors linked with `aria-describedby`, first invalid field focused on failed submit, `inputmode="numeric"` for duration/attempts.

---

## 5 · Implementation notes for the build

- One store, mutated only by SSE events (see frontend brief §5). Nothing in this spec requires state the store does not already hold.
- Status colour, glyph, chip recipe and allowed actions all derive from one place — mirror `lib/matrix.ts` for actions and add a single `status.ts` for colour/glyph/label. No per-screen switches.
- The duration readout needs `status`, `created_at`, `updated_at` and `attempts` only; compute the label from status. Elapsed for running ticks client-side (presentational, not polling).
- Skeletons, empty states and the three connection states are real code paths, not nice-to-haves — they are the states the app is in most often.
- Deliberately out of scope: light theme, account/profile UI, webhook rules, full-text search over params and error reasons, charts, metrics tiles, throughput graphs, progress indication of any kind. (Handle-and-id search **is** in scope and built — §3.13.)

---

## 6 · The mark

The **ember bar**: a vertical bar with a bottom-hot gradient — half progress indicator, half burner flame.

- Bar: `8 × 22 px`, `border-radius: 1px`, `background: linear-gradient(180deg, #ffb347, #ff5a1f)`
- Lockup: bar + `11px` gap + "BackBurner" in Archivo 700 / 16px / -0.01em
- Aspect ~1:2.9 at all sizes; radius 2–3px above 24px tall
- Hot end always at the bottom. May glow when work is running; **must NEVER fill or deplete** — no progress implication, because the engine cannot know worker progress.

---

## 7 · Design gaps resolved at build time

The approved design did not cover the following. Each was resolved during the Phase 5 build; where the resolution departs from `frontend-brief.md` it carries an ADR.

| Gap | Resolution |
|---|---|
| Sidebar identity chip showed a username (`daniel`) and avatar initials | **Dropped.** No endpoint can tell the SPA who it is; a name would be invented state. The chip shows the masked key alone (`bb_9f2c…6b54`). See ADR 0020. |
| The queued state note read `queued behind 3 tasks · attempt budget 3` | **Queue position dropped** — it is not derivable from any endpoint. The note keeps `attempt budget 3`, which is just `max_attempts`. Same reasoning as ADR 0020. |
| Every count in the design (sidebar totals, `4 running · 1 to collect`, `Show 312 tasks`, `10 of 312`, `LIVE · 2` / `HISTORY · 310`) | **Built.** Additive `counts` object on `GET /tasks`; see ADR 0018 and `api-contract.md`. Six fields, each with its own filter basis. |
| Submit form's lane buttons and the sidebar LANES list had no source | **Built into counts** as `counts.lanes` — the engine's *registered* lanes, so a user with zero tasks still gets a working lane picker. |
| Date-range (`from`/`to`) filters — in `frontend-brief.md` §4.2, on no design screen | **Built**, in the mobile filter sheet and a desktop filter affordance, in the established idiom. |
| Desktop could only sort by `created_at` (the column header) | **Built** a created ↔ updated field switch on desktop, matching the mobile sheet's SORT control. |
| Where `/submit` renders in three-pane view | Replaces the register + detail area as a single centred panel; the sidebar persists. |
| Detail-screen **loading** and **404 not-found** states | Built in the established idiom — skeleton identity block for loading; mono error panel plus a link back to the register for 404 (`frontend-brief.md` §4.4 copy). |
| Whether Notifications is a route or an overlay | **Overlay.** Anchored popover on desktop, full-width drawer on mobile, opened from the sidebar nav item and the mobile header bell. No `/notifications` URL — `frontend-brief.md` §2 already places the notification layer outside routing, so this needs no ADR. |
| Infinite scroll (design) vs. a "Load more" button (`frontend-brief.md` §4.2) | **Infinite scroll**, per the design. See ADR 0019. |
| How the detail pane renders `created` / `updated` | **Human first.** Line 1 is the local absolute (`26 Jul 2026 · 14:32:07`) plus the existing relative supplement; line 2 is the API's ISO `Z` instant, mono, `--text-quiet`, selectable and with the same `copy` control the id carries. The block still speaks UTC — the instant is demoted, never dropped, because an operator correlating with a server log has to paste it verbatim. |
| Where the infinite list ends | The scroll container carries `clamp(180px, 40vh, 480px)` of bottom padding (mobile: the 86px action-bar clearance, the safe-area inset, and then the same), so the final row can be scrolled clear of the bottom edge. Rows flush against the viewport bottom sit under the browser's own link-target tooltip. |
| Failed toasts: `frontend-brief.md` §7.1 said "persists until dismissed" | **Auto-dismiss at 15 s**, countdown visible, held while hovered or focused. The assessment spec requires an unprompted completion notice, not a persistent one, and the notification centre is the durable session record. See ADR 0023; §7.1 of the brief now says the same. |
| Where the `uncollected` filter lives, now that `?uncollected=true` exists (ADR 0022) | **Its own row/chip, never inside STATUS.** Sidebar band between nav and STATUS, leading chip on the mobile rail and in the filter sheet, and the register toolbar's first pressable number. §3.1's "there is no sixth status" is why. See §3.10. |
| The register toolbar's `N running · N to collect` summary was inert text | **Both numbers are buttons** that apply the filter they name and toggle off on re-press. A count that opens the list it describes is §3.10's rule; a clickable number beside an inert one reads as a defect. |
| The `⌘K` field was an exact jump-to, and its copy said "BackBurner has no text search" | **False since ADR 0022.** Rewritten as a real prefix search over handle and id, ranked by the server, with a degraded local fallback. §3.13 replaced wholesale. See ADR 0027. |
| Submit's Outcome was a top-level three-option select defaulting to Succeed | **Moved into ADVANCED**, gains **Random** (the default) and **Flaky**. Random is rolled in the browser into explicit params — the server default must stay deterministic for the criteria tests. See ADR 0028. |
| Submit's duration helper hard-coded "the engine picks 3–15 s" | **Wrong on `build` (20–90 s) since ADR 0021.** Sourced from `counts.lane_defaults`; with the field absent the sentence claims no numbers at all (`frontend-brief.md` §6.5). |
| The three-pane detail pane rendered a resting "Select a task…" panel | **Retired.** The pane is not shown with nothing selected and the register spans the row, which is what makes the eight-track register reachable at 1280px. §2, §2.1 and §3.11 updated; see ADR 0026. |
| Fixed 230px sidebar and 446px detail pane on every viewport | **Both draggable**, bounded by `clamp(<min>, var(--…-w), 30vw / 50vw)` so the caps hold in CSS with no resize listener. §2; see ADR 0025. |
