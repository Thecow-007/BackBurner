# Orchestration Brief — Phase 5 (Web SPA) + Phase 6 prep

> **⚠️ Historical — Phase 5 is complete.** This playbook was written *before* the web build and
> describes it in the future tense; everything its "What is missing" section lists below now
> exists, including the `counts` endpoint, the store's React binding, all four screens, and the
> dev/production serving paths. It is kept for the record of how the build was driven, not as a
> description of the current tree. For what the SPA actually does, read
> [`frontend-brief.md`](./frontend-brief.md) and [`ui-spec.md`](./ui-spec.md); for what remains,
> read [`build-plan.md`](./build-plan.md) Phases 6–7. The Dockerfile, deploy workflow and
> Codespaces re-verification it mentions as a parallel track are still outstanding.
>
> **Status of this document.** A working playbook for a multi-agent build, not normative law. The
> design authority remains [`frontend-brief.md`](./frontend-brief.md) §§2–10, the assessment spec,
> and the final design page Daniel provides. Where this brief and those disagree, they win. This
> file exists to tell an **orchestrator** how to drive a fleet of Sonnet subagents through the web
> build without producing drift, collisions, or dishonest UI — and to define the control it must
> keep for itself.

---

## 0. What this is

The goal: build `@backburner/web` (the React SPA) to the frontend brief and the final design page,
verify it live against a seeded backend through Chrome, and take Phase 6 infra as far as it goes
without secrets. An orchestrator (Opus) directs bounded Sonnet subagents; a human (Daniel) finishes
what only he can.

**What already exists — do not rebuild it.** The web *data layer* is done and solid:

- `packages/web/src/lib/` — `types.ts`, `api.ts` (`ApiClient`), `sse.ts` (`SseClient`), plus pure
  helpers `filters.ts`, `matrix.ts`, `storage.ts`.
- `packages/web/src/store/store.ts` — the Zustand **vanilla** store. This is the brain: snapshot +
  `as_of`, SSE-only mutation, pending-until-confirming-event, zero polling, dedup by event id. The
  React layer binds to it; it does not replace it.
- `packages/web/src/index.ts` — the barrel that exports all of the above.

**What is missing — the build.** React/Vite/router scaffolding; the design system; a React binding
to the vanilla store; a set of shared primitives; the four screens plus header, sidebar, toasts,
and notification center; the dev proxy; production static serving; and (parallel track) the `counts`
endpoint, Dockerfile, deploy workflow, and README refresh.

**The store has no `counts` yet.** The design's sidebar totals require a new endpoint *and* a store
addition *and* a UI binding — this spans tracks and is coordinated by the orchestrator, never
owned by a single leaf agent. See §6.

---

## 1. The hard prerequisite — do not skip

**Nothing starts until the baseline is green, running, and seeded.** Gate B is "all 9 criteria green
before web work"; it has never been confirmed on this machine, and Chrome cannot inspect a backend
that isn't up. The orchestrator's very first actions, in order:

1. `docker compose --profile dev up -d postgres` — confirm it's healthy.
2. `npm ci && npm run build && npm run migrate`.
3. `npm test` — the **full** matrix (unit + criteria + supplemental) must pass. A red baseline is a
   stop-the-line defect, not a "build the UI anyway."
4. `npm run seed -- --tasks 300` — capture the printed raw API keys; the UI and the visual QA loop
   need them.
5. Start the API and confirm `GET /tasks` returns real seeded data with a seed key.

Only then does Round A begin. If the matrix is red, the orchestrator fixes the backend (or surfaces
it to Daniel) before touching web code — building UI on a broken engine wastes the whole fan-out
chasing ghosts through the browser.

---

## 2. The orchestrator's job — and what it must never delegate

The orchestrator is a **hands-on lead**, not a dispatcher. It personally owns everything that needs
whole-system context, and delegates only work that is genuinely leaf-shaped and boundable.

**The orchestrator does itself (never delegates):**

- The **green baseline** (§1) and the **live app** during QA.
- The **foundation** — scaffolding, design tokens, the React-store binding, and the shared-primitive
  *interfaces*. This is the contract every screen agent builds against; it must be built and frozen
  by one mind.
- **Integration** — wiring screens into the router and shell, reconciling any cross-screen
  inconsistency.
- The **visual QA loop** (§9) — running Chrome, comparing to the design page, deciding what's wrong.
- **Every acceptance decision** — re-running typecheck/build and the boundary check on each agent's
  output before merging it (§8). An agent's "done" is a claim, not a fact.
- Any change to a **shared file** (§5) — these are mutated only *between* fan-out rounds, never
  during one.

**The orchestrator delegates (leaf work):**

- Individual **shared primitives**, once their interface is fixed (one component per agent).
- Individual **screens**, once the foundation is frozen (one screen per agent).
- Independent **infra/backend tasks** on the parallel track — `counts`, Dockerfile, deploy workflow,
  README (§6).
- **Single-screen visual fixes** discovered in QA (cross-cutting fixes stay with the orchestrator).

---

## 3. How to control agents — eight rules

These are the load-bearing part of this brief. Multi-agent UI builds fail in predictable ways; each
rule below closes a specific failure mode (§3.9 tabulates them).

**3.1 One writer per file, always.** The orchestrator maintains the file-ownership map (§5). No two
concurrent agents may create or edit the same file. Shared files have exactly one owner: the
orchestrator.

**3.2 Freeze interfaces before you fan out.** Screen agents import primitives and store selectors
against a **committed, frozen** surface. The design tokens, each primitive's props, and the store's
React hook must exist and be locked before Round B starts. An agent that needs a new prop *requests
it* from the orchestrator; it does not edit the primitive.

**3.3 Tight briefs, never themes.** No agent is told "build the dashboard." Each gets: the exact
files it owns (create vs. edit), the interfaces it may import and must not modify, the guardrail
block (§7) verbatim, the binding brief section and design-page region, a concrete definition of
done, and the required return format. Vague scope is how agents wander and collide.

**3.4 Verify, don't trust.** Every agent self-reports success. The orchestrator independently
re-runs the verification gates (§8) — typecheck, build, and the forbidden-import grep — before
accepting anything. A subagent's final message is data to check, not a status to believe.

**3.5 Reject and re-scope; do not patch over.** When an agent drifts, revert its output and re-issue
a sharper brief. Hand-fixing an agent's mistake hides the systematic cause (usually a loose brief)
and doesn't scale across a fan-out. The exception: a one-line obvious typo is cheaper to fix than to
round-trip — use judgment, but bias to re-scope.

**3.6 Bounded concurrency.** Run ~3–4 leaf agents at once, not ten. Enough to save wall-clock; few
enough that the orchestrator can actually review each return, and that a bad round is cheap to
redo. More agents than you can review is not parallelism, it's a backlog of unverified claims.

**3.7 Integration and taste stay home.** Merging into the router, resolving cross-screen drift, and
every "does this look right" call belong to the orchestrator. These need the whole picture; an agent
holding one screen cannot make them.

**3.8 The design page is frozen; agents render it, they don't reinterpret it.** No agent "improves"
the palette, invents a component the design doesn't show, or adds a flourish. Deviations are the
orchestrator's call, made deliberately and noted — the same silent-drift-is-a-defect rule the repo
runs on everywhere else.

**3.9 Failure modes and their countermeasures:**

| Failure mode | Looks like | Countermeasure |
|---|---|---|
| Token drift | Two screens with slightly different greys / spacing | Tokens frozen in Round A; agents may only reference `var(--…)`, never author raw hex (§7, §8) |
| Duplicate components | Three hand-rolled buttons | Primitives built and frozen before screens; screens import, never define UI atoms |
| Shared-file collision | Two agents edit the router / `index.css` | One-writer rule (§3.1); shared files are orchestrator-only (§5) |
| Scope creep | An agent "helpfully" refactors the store | Briefs name owned files explicitly; the store is off-limits to screen agents |
| Design reinterpretation | Colors/labels that aren't on the design page | §3.8; the guardrail block pins the non-negotiable design decisions |
| Boundary violation | `import … from "@backburner/engine"`, a raw `fetch`, a `pg` import | Forbidden-import grep is an acceptance gate (§8) — a hit is an automatic reject |
| Fabricated green | "Typecheck passes" when it doesn't | Orchestrator re-runs typecheck/build itself; never accepts the claim (§3.4) |
| Dishonest UI | A fake count, a progress bar, an invented status | The honesty rule (§7) is in every brief; the orchestrator eyeballs for it in QA |

---

## 4. The build sequence

Three serial rounds on the critical path, one infra track running alongside. Gates between rounds
are hard: Round B does not start until Round A is committed and frozen.

### Round A — foundation (serial, orchestrator or a single agent under close review)

1. **Scaffolding.** Add `react`, `react-dom`, `react-router-dom`, `vite`, `@vitejs/plugin-react` to
   `packages/web/package.json`; add `dev` and `build` scripts (so `scripts/dev.mjs` and
   `scripts/build.mjs` stop skipping web). Create `vite.config.ts` with the dev proxy for `/tasks`,
   `/events`, `/health`; `index.html`; `src/main.tsx`; JSX in the tsconfig.
2. **Design system.** Translate the design page into a token layer — CSS custom properties for the
   palette (dark-first, both themes), type, spacing. This is the single source every component reads.
3. **React-store binding.** A provider + `useStore(selector)` hook over the existing vanilla store,
   plus `bootstrap()` on load. Screens consume the store *only* through this.
4. **Shared primitives (interfaces frozen here; bodies may be delegated one-per-agent):** `Chip`
   (5 statuses), `Button` (default / pending / disabled), `Panel`, `SeedBadge`,
   `ConnectionIndicator` (3 states), `StatusSlot` (the always-present duration slot), `Timeline`
   (rail, attempt groups, duration gaps, dashed backoff waits — the hardest one), `JsonPanel`
   (collapsible + copy), `Toast`, `EmptyState`, `SkeletonRows`, `ConfirmDialog`.

**Gate A→B:** typecheck + build green; the app boots to an empty shell; primitive props are
committed and will not change. **Commit before fanning out.**

### Round B — screens (parallel, ~3–4 agents, one screen each)

- **API-key gate** — the pre-app surface (frontend-brief §4.1).
- **App shell** — persistent header + sidebar + the three-pane responsive layout and pane collapse
  (§4.2 here; brief §2, §9). Owns routing structure handoff to the orchestrator.
- **Task register** — table (desktop) / cards (mobile), filter bar, jump-to search, load-more
  (brief §4.2).
- **Task detail** — identity header, `StatusSlot`, metadata, params, result/error, `Timeline`,
  action bar (brief §4.4).
- **Submit** — lane, duration + humanized preview, the outcome demo control, advanced, confirmation
  panel (brief §4.3).
- **Notifications** — toasts (transient success / persistent failure) + notification center
  (brief §7).

Each screen agent imports frozen primitives and store selectors; defines only its own screen files;
returns for review. **The orchestrator integrates** — screens do not wire themselves into the router.

**Gate B→C:** every screen typechecks, builds, imports nothing forbidden, and renders in isolation.

### Round C — integration + visual QA (serial, orchestrator)

Wire the router (`/`, `/submit`, `/task/:id` — **id, never handle**), mount the shell, run against
the seeded backend, then the visual QA loop (§9). Single-screen fixes may be delegated back; token
or shared-primitive fixes are the orchestrator's. Last: production static serving — the API serves
the built SPA with the route-coexistence rule (api-contract §9), which needs `@fastify/static`.

### Parallel infra track (independent, fan out anytime after §1)

`counts` endpoint, Dockerfile, deploy workflow, README refresh — none depend on the UI (see §6 for
the counts caveat). These can run concurrently with Rounds A–C.

---

## 5. File-ownership map (collision prevention)

The orchestrator keeps this current and never lets two concurrent agents share a row.

| Path | Owner | Mutable during a round? |
|---|---|---|
| `packages/web/package.json` | Orchestrator | No — set in Round A |
| `vite.config.ts`, `index.html`, `tsconfig.json`, `src/main.tsx` | Orchestrator | No |
| `src/theme/` (tokens, global css) | Orchestrator (Round A) | No — frozen before Round B |
| `src/store/react.tsx` (the binding hook) | Orchestrator | No |
| `src/components/<Primitive>.tsx` | One agent each (Round A) | No after freeze |
| `src/screens/<Screen>/…` | One agent each (Round B) | Yes — only that screen's owner |
| `src/router.tsx`, `src/App.tsx` | Orchestrator (Round C) | Integration only |
| `src/lib/*`, `src/store/store.ts`, `src/index.ts` | **Off-limits to screen agents** | Store/counts changes are orchestrator-coordinated |
| `packages/engine/*`, `packages/api/*` | Infra-track agents only, per task | Per task |

Screen agents that believe they need to touch an off-limits file must ask the orchestrator, which
either makes the change itself or widens that agent's ownership deliberately.

---

## 6. The task backlog (agent-sized units)

Each row is one agent's brief seed. The orchestrator expands each into a full brief with the §7
guardrail block, the exact design-page region, and the §8 definition of done attached.

**Round A (foundation):**

| # | Task | Owns | Depends on |
|---|---|---|---|
| A1 | Scaffolding + dev proxy | package.json, vite.config, index.html, main.tsx, tsconfig | §1 green |
| A2 | Design tokens (both themes) | `src/theme/` | design page |
| A3 | React-store binding + bootstrap | `src/store/react.tsx` | A1 |
| A4–A9 | Primitives, one agent each | `src/components/<X>.tsx` | A2, A3 frozen |

**Round B (screens), one agent each:** gate · shell+sidebar · register · detail · submit ·
notifications. Depends on Round A committed.

**Parallel infra track:**

| # | Task | Owns | Notes |
|---|---|---|---|
| I1 | `counts` endpoint | engine `counts()`, api field/route, api-contract, new ADR, supplemental test | **Also needs a store addition + UI binding** — orchestrator threads these into A3/shell. Counts must respect every active filter *except* the one they represent (build-plan backlog note). Land this early so the sidebar binds to something real; until then the store returns `null` and the sidebar shows a neutral placeholder, **never a fabricated number**. |
| I2 | Dockerfile (multi-stage, Node 22) | `Dockerfile` | deployment.md §2; `docker-compose.yml` already wires `build: .` |
| I3 | Deploy workflow | `.github/workflows/deploy.yml` | deployment.md §3; **writes the file only** — never holds secrets or runs a real deploy |
| I4 | README refresh | `README.md` | Flip the "not yet built" status; add nothing untrue about deploy until it's live |

---

## 7. The guardrail block — paste into every agent brief verbatim

```
BINDING CONSTRAINTS — do not violate, do not "improve" around.

PACKAGE BOUNDARY (@backburner/web is a pure API consumer):
- fetch + EventSource ONLY, and only through the existing lib/api.ts and lib/sse.ts.
- NEVER import @backburner/engine or @backburner/api. NEVER import pg. NEVER touch the DB.
- Consume server state ONLY through the store's React binding. Do not add your own fetches.

STORE DISCIPLINE (frontend-brief §5 — already implemented; render it, don't fight it):
- The store mutates only on SSE events. Action buttons call REST and go PENDING until the
  confirming event arrives — not until the HTTP response returns. Show pending as a TEXT change
  ("Cancelling…", "Retrying…", "Collecting…"), not a spinner alone.
- Zero polling. No setInterval refresh, no refetch-on-focus, no refresh button.
- Correlate everything by immutable task id. Route by id (/task/:id), never by handle.

SPEC SHAPES ARE VERBATIM:
- The five statuses render exactly: queued · running · ready · failed · cancelled.
- A collected task keeps its status chip plus a QUIET secondary marker. There is NO sixth status.
- Full error text, never truncated. No progress bars — elapsed-time counters only, labelled
  as elapsed (we cannot know worker progress).

DESIGN DECISIONS (locked this pass):
- running = BLUE. ember = brand + primary action + the "Reconnecting…" state ONLY. Ember appears
  NOWHERE in the task table and NOWHERE in the timeline; timeline nodes take the color of the
  status they transitioned TO.
- No "Account" nav, no "Notification rules" nav — those capabilities don't exist.
- The search box is JUMP-TO (exact handle or id), not text search.
- "Collect result" on ready (acts immediately) vs "Collect / acknowledge" on failed (confirms
  first, then retires Retry). Collect is a read that MUTATES — the label must carry the consequence,
  and it fires only on an explicit press, never from a render, navigation, or notification tap.
- Spell out "collected" and "ATTEMPTS"; queued rows show "—" for attempts, not "0 / 3".

MOBILE + A11Y (frontend-brief §§9–10): works at 375px; touch targets ≥ 44px; WCAG AA contrast for
chip text and body; status never by color alone (the word is always present); respect
prefers-reduced-motion; visible keyboard focus.

THE RULE UNDERNEATH ALL OF IT: this dashboard's pitch is honesty about system state. Never show a
number you can't source, a status the engine didn't announce, an error you truncated, or progress
you can't know. Resolve every judgment call that way.
```

---

## 8. Verification gates — the orchestrator runs these on every return

An agent is accepted only when **all** pass, re-run by the orchestrator (not taken on the agent's
word):

1. `npm run typecheck` (or `tsc --noEmit` in the web package) — clean.
2. `npm run build` — the web package builds.
3. **Forbidden-import grep** returns nothing:
   `grep -rE "@backburner/(engine|api)|from ['\"]pg['\"]|new EventSource|fetch\(" packages/web/src/components packages/web/src/screens`
   (raw `fetch`/`EventSource` outside `lib/` is a boundary break; engine/api/pg imports are always a
   break.)
4. **Raw-hex grep** in components/screens returns nothing (`#[0-9a-fA-F]{3,6}` outside `src/theme/`)
   — colors come from tokens only.
5. The owned files match the ownership map — the agent created/edited only what it was assigned.
6. Spot-check against the brief section and design region: does it actually implement the state, or
   just the happy path? (Empty states, pending states, and the failed/collected variants are the
   usual misses.)

A failure on 3 or 4 is an **automatic reject** (§3.5) — those are the boundary and the design
system, the two things the fan-out exists to protect.

---

## 9. The visual QA loop (Round C, orchestrator via Chrome)

With the app running against the seeded backend:

1. `tabs_context_mcp` first, then a fresh tab; sign in with a seed key.
2. For each screen, screenshot at **desktop and 375px**, compare to the design page.
3. Walk the states the happy path hides: a `failed` task's detail, a `collected` one, an empty
   filter result, the pending button state mid-action, the three connection states, the three
   responsive pane counts.
4. Single-screen fixes → delegate back to that screen's agent with a precise diff. Token or
   shared-primitive fixes → orchestrator does them, then re-verifies every screen that consumes the
   changed token.
5. Do not trigger native browser dialogs (alerts/confirms block the extension) — the app's own
   confirm modals are fine; JS `confirm()` is not.

QA is done when every screen matches the design at both widths and every state in §3 of the brief
renders truthfully.

---

## 10. The human handoff line

Agents take it as far as **all code + all local verification**. What remains is genuinely
Daniel-only, and the orchestrator should stop and hand off cleanly rather than fake it:

- **Deploy secrets and DNS** — the SSH host/key, GHCR credentials, Cloudflare subdomain. The deploy
  workflow file (I3) is written and committed; it is never *run* by an agent, and no secret ever
  enters the repo, a commit, or an agent's context.
- **Codespaces clean-create re-check** (build-plan Phase 6 / deployment §7) — a human creating a
  fresh Codespace and confirming boot + migrate.
- **Recording the demo** — the 15–30 min walkthrough.
- **Final taste calls** on the design, and anything this brief marked as the orchestrator's judgment
  that Daniel would rather make himself.

The orchestrator's exit report should state plainly: what's built and verified green, what's built
but unverified (and why), and the exact remaining steps on the human-only list — no rounding up.
