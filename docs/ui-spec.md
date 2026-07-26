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
```

**Ember is not a status.** It is permitted in exactly three places: the wordmark, the primary action button, and the `Reconnecting — data may be behind` connection state. It appears **nowhere in the task table and nowhere in the timeline**. Running-orange beside failed-red made a healthy screen read as an alarming one; that is why running is blue.

Derived recipes (`S` = the status colour):
- Status chip, non-running: `background: S + '16'`, `border: 1px solid S + '3d'`, `color: S`.
- Status chip, running: solid `#58a6ff` fill, `#06131f` text, weight 700, pulse animation.
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
| ≥ 1280px | three: sidebar 230 · register flex · detail 446 | persistent right pane; selecting a row fills it |
| 900–1279px | two: sidebar 230 · register flex | selecting a task **replaces the register** with detail + a `← Register` affordance; sidebar never moves |
| < 900px | one | sidebar becomes a drawer; register becomes stacked cards; detail is a full screen |

The URL is always `/task/:id`, keyed by the immutable id, at every pane count. Handles recycle; a link must never come to mean a different task later.

Register row grid (three-pane, 760px available):
`4px 116px 116px 70px 82px 96px minmax(180px,1fr)` with `column-gap: 12px` and 16px right padding — gutter · HANDLE · STATUS · LANE · ATTEMPTS · CREATED · NOTE. **Header and rows must share identical tracks and gap.** Any future column must be budgeted against the pane width, not added optimistically; NOTE carries error text and must never ellipse below ~180px.

There is **no ACTION column in three-pane view** — the detail pane is always present. Inline row actions exist only at ≤ 2 panes (revealed on hover and keyboard focus in the desktop table; always visible on mobile cards).

Wide content (JSON panels) scrolls inside its own container. The page never scrolls sideways.

---

## 3 · Components

### 3.1 Status chip — 5 variants
Status word always inside the chip, verbatim from the API, never paraphrased, never colour-alone. Leading glyph: queued `·` running `▸` ready `✓` failed `✕` cancelled `⊘`. Mono 11px, padding 3×9, radius 999. Running is the only variant that animates.

There is no sixth status. A collected task keeps its chip (at `.72` opacity) and gains the collected marker below.

### 3.2 Collected marker
The word `collected`, mono 10px, `--text-dim`, `border-bottom: 1px dotted #4a3830`. Never abbreviated — collected-vs-uncollected *is* the handle-lease concept. Sits beside the chip on detail, in the NOTE cell on desktop rows, in the card's chip line on mobile.

### 3.3 Seed badge
`seed`, mono 9.5px, tracking .12em, `--text-dim` on `1px solid #33261f`, radius 2. Quiet by design: it marks synthetic history, it is not a warning.

### 3.4 Task row / card
Desktop: the grid above; gutter is a 3px `running`-blue rail on live rows only; hover fills `--bg-raised`. NOTE shows the first line of `error.reason` for failed rows in `#ff8a7a`, otherwise the state note in `--text-dim`. Queued rows show `—` in ATTEMPTS, never `0 / 3` — zero-of-three implies a spent attempt.

Mobile card (5c): line 1 handle (mono 15–17) + chip + collected marker + seed badge; line 2 the note (wraps, `text-wrap: pretty`, full reason for failures); right side one action button, min-height 44. Live rows keep the blue left rail and a faint blue wash `linear-gradient(90deg, rgba(88,166,255,.10), transparent 55%)`.

### 3.5 Timeline — the best component; do not redesign
Vertical rail, grouped by attempt. Group rule: `ATTEMPT 2 OF 3` on the left, hairline, per-attempt duration on the right (`11.7s`). Nodes: dot + event type (mono 12.5) + `from → to · meta`, timestamp right-aligned. Backoff waits render between groups as a 2px dashed vertical segment (`repeating-linear-gradient(180deg, #4a3830 0 4px, transparent 4px 8px)`) labelled `backoff 2.0s — waiting`.

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

At one pane the counts survive as a horizontally scrolling chip rail above the list, with a right-edge fade (`linear-gradient(90deg, transparent, --bg-app 70%)`) so it reads as scrollable.

### 3.11 Empty, error and resting states
- **No tasks yet** — heading `No tasks yet`, one line of prose, ember `Submit your first task`.
- **No tasks match these filters** — distinct copy, the active filters echoed in mono, secondary `Clear filters`. Must not look like the above; one is a new key, the other a filter mistake.
- **Snapshot failed** — red-railed panel, the envelope `message` verbatim in mono, `Retry` button. Never a blank pane.
- **Detail pane, nothing selected** — centred: a dim ember bar glyph, one line — "Select a task to see its parameters, full history and the actions its status permits."
- **Loading** — skeleton rows (3 bars per row, `#241a15` / `#1d1512`), one per expected row. No spinner, no layout shift. Shown on first snapshot and on every filter change.

### 3.12 JSON panels
`#16100d` on `1px solid #2b1e18`, radius 4, mono 12/1.65–1.7, `--text-mono-body`, `white-space: pre`. Header line: micro-label left, `copy JSON` right. Collapsible where long. Params always shown; result only when collected; error **never** truncated (`white-space: pre-wrap; word-break: break-word`).

### 3.13 Search = jump-to
There is no text-search endpoint. The field is an exact **handle or id** lookup: placeholder `jump to handle or id…`, `⌘K` badge, Enter navigates to `/task/:id`. Keep the overlay pattern (results list, `↑↓ move · ↵ open · esc close`) but only ever resolve exact matches. Do not imply searching error text.

### 3.14 Sidebar inventory
Wordmark → connection indicator → nav (`Task register` with total, `Submit task`, `Notifications` with unread badge) → STATUS counts → LANES counts → footer identity chip (`daniel · bb_9f2c…6b54`) + `change key`.

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
- Deliberately out of scope: light theme, account/profile UI, webhook rules, text search, charts, metrics tiles, throughput graphs, progress indication of any kind.

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
