# 0028. Random submit outcomes, rolled in the browser

Status: Accepted — 2026-07-26

## Context

The submit form's Outcome control was a top-level, three-option select defaulting to **Succeed** (`frontend-brief.md` §4.3). Submitting repeatedly with the defaults therefore produced a wall of `ready` tasks: a register with no failures in it, no retries, no backoff markers on any timeline, and nothing for the notification centre to say beyond "finished". The lifecycle the product exists to make observable was invisible unless you went looking for the control that produced it.

The repo owner asked for two changes after driving the built dashboard: the everyday submit should produce a lively mix, and the outcome control — which is a demo control, not an operational one — should be tucked out of the way.

"Produce a mix" reads at first like a server-side default: let the mock worker roll dice when no outcome param is given. It cannot be. The nine criteria tests submit with `duration_ms` and nothing else, and require the task to reach `ready`. `api-contract.md` §1 states the rule outright — "With **no** outcome param set, a job always succeeds. The default outcome is deterministic and never a server-side dice roll." A probabilistic default would make the reviewer's acceptance suite flaky by construction, which is the single worst thing this repo could ship.

[ADR 0021](./0021-flaky-outcomes-attempt-context-and-per-lane-durations.md) also added `params.fail_times: n` — a retryable failure while `attempt <= n`, then success — which is the fails-then-recovers path the register had no way to demonstrate. It was reachable by curl and by nothing in the UI.

## Decision

**The dice belong to the SPA.** The Outcome control gains a **Random** option, which is the default, and Random is resolved **client-side, at press**, into explicit `params`. The request that leaves the browser always says exactly what it wants; the engine's no-outcome-param path stays a guaranteed success and the criteria tests stay deterministic.

The weights are the owner's:

| Outcome | Weight | Params sent |
|---|---|---|
| Succeed | 0.65 | *(none)* |
| Flaky | 0.15 | `fail_times: n` |
| Fail — retryable | 0.13 | `fail: true` |
| Fail — permanent | 0.07 | `fail_permanent: true` |

The RNG sits behind an injectable seam — `Submit` takes an optional `random: () => number` that the app never passes — so the roll is pinned by a unit test rather than merely plausible. The option's own helper text names the weights: a demo control that will not tell you its odds is a control you cannot reason about.

**The whole Outcome control moves inside the collapsed ADVANCED section**, beside `max_attempts`, and gains two options: **Random** and **Flaky**. The collapsed toggle states the current choice (`outcome · random`), so a non-default selection is never hidden behind a closed section.

**Flaky is bounded so it can actually recover.** `fail_times` must be strictly below the attempt budget — at or above it, the task simply exhausts the budget and lands in `failed`, which is the one thing a "flaky" submit must not do. The rule the form applies:

- `max_attempts` left blank → **clamp `fail_times` to 1.** A blank budget means the engine applies the lane's configured default (`api-contract.md` §6.1), which no endpoint reports to a client. The SPA must not assume 3 — it cannot see it — and 1 is the only value that recovers under every budget above 1.
- `max_attempts` set to N → allow 1…N−1, capped at the wire's own ceiling of 9. (`max_attempts` maxes at 10, so N−1 lands exactly on it.)
- N = 1 → **Flaky is disabled**, with an inline note saying a flaky task needs a budget above 1.

The random roll obeys the same bound. When flaky is impossible its 0.15 slice folds into `succeed` rather than being redistributed across the failures: a budget of 1 is already the harshest setting on the form, and quietly making failure 18% more likely because of it would be a surprise.

Choosing Flaky explicitly reveals a compact `fail_times` field, default 1, so a demo is reproducible rather than a coin flip — the owner's phrasing was "fails once or twice, succeeds on a later retry", and 1–2 is the useful range.

## Alternatives considered

- **Roll on the server when no outcome param is given.** The obvious place for it, and it would make every client — curl included — produce a mix. Rejected because it breaks the criteria tests by construction and contradicts a rule `api-contract.md` §1 states in one sentence. Nothing about a nicer demo is worth a probabilistic acceptance suite.
- **A server-side `params.random: true`.** Keeps determinism by default while moving the roll to the engine, and would give a stable `params` echo. Rejected because the roll would then be invisible: the stored `params` would say `random: true` and the task's actual outcome would be unexplained, where client-side resolution stores `fail_times: 1` and the task object says exactly why it behaved as it did. It also adds a mock-worker param that exists purely to serve one client.
- **Keep Succeed as the default and leave the control where it is.** No change at all, and the brief's current text stays correct. Rejected on the owner's evidence: the default is what almost every submit uses, and a default that never exercises failure makes the product's central story — retry, backoff, the failed-then-recovered timeline — something you have to be told about rather than something you see.
- **Randomise the duration too.** Would make the register livelier still. Rejected as unnecessary: the engine already picks a random duration from the lane's own range when `duration_ms` is omitted, deterministically recorded into the stored params (ADR 0021). The variety is already there and is already the server's.
- **Weight the mix toward failure, so demos are dramatic.** Rejected because the register should look like a system that mostly works. 65/35 is a working system with real problems in it; 50/50 is a broken one.
- **Let `fail_times` reach the attempt budget and land in `failed`.** One fewer rule, and it is a legal request the API accepts. Rejected because the option is called Flaky and a control must do what it says: a "flaky" task that can never recover is a failure with extra steps, and the operator would have no way to tell which they had asked for.
- **Assume the global default of 3 when `max_attempts` is blank.** Would let a blank budget still offer `fail_times: 2`. Rejected because 3 is the *global* fallback and a lane may configure its own; the SPA cannot see which, and guessing a number the API did not supply is exactly what `frontend-brief.md` §6.5 forbids.

## Consequences

- `frontend-brief.md` §4.3 is rewritten: Outcome is no longer a top-level three-option select, ADVANCED no longer holds only max-attempts, and the duration field's "the engine picks 3–15 s" is replaced by a sourced range (see below).
- `Submit.tsx` exports `rollOutcome`, `flakyBound`, `clampFailTimes` and `OUTCOME_WEIGHTS` so the roll and its bound are unit-tested with a pinned RNG. The weights are asserted to sum to 1, and `clampFailTimes` is asserted never to return a value at or above the budget it was given.
- `SubmitInput` and `lib/api.ts` gain `fail_times`; nothing else about the submit path changes.
- **The duration helper text is now sourced.** It stated "the engine picks 3–15 s", which ADR 0021 made wrong on `build` (20–90 s). It now reads the selected lane's real range from `counts.lane_defaults`, and when the server omits that field it claims no numbers at all rather than guessing — `frontend-brief.md` §6.5 bars the form from stating a range it cannot source.
- A submitted task's `params` always names its outcome explicitly, so the detail screen's Params panel explains the run without the reader having to know what the form rolled.
- Two submits with identical form state can produce different outcomes. That is the feature; the ADVANCED summary line and the four explicit options are how an operator opts out of it.
