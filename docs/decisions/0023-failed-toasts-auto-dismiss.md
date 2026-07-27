# 0023. Failed toasts auto-dismiss after 15 s

Status: Accepted — 2026-07-26

## Context

`frontend-brief.md` §7.1 specified two toast lifetimes: a ready toast "auto-dismisses after ~6 s", and a failed toast "**persists until dismissed** — failures must not evaporate unseen." The implementation went further than the brief and hard-coded the rule into the component: `Toast.tsx` forced `dismissAfterMs = 0` for a failure whatever the caller passed, so no call site could have chosen otherwise.

Driving the running dashboard is what surfaced the cost. Failures are not rare in this product — the mock worker's `fail` and `fail_permanent` params exist so they can be reproduced on demand, the seed set is full of them, and the retry loop means one unhappy task can announce itself several times. Every one of those left a red card on screen until it was dismissed by hand, and three of them at once is the stack limit, so the fourth notice queues behind housekeeping the operator has to do before it can be seen.

The question that decides it is whether the assessment requires persistence. It does not. `docs/assessment-background-job-runner.md` asks that "the moment a job finishes, the user gets a clear completion notification surfaced without any action on their part" — a requirement about *arrival without asking*, not about *staying until acknowledged*. Nothing in the spec, and nothing in the API contract, turns on a toast's lifetime.

Meanwhile the thing the brief was actually protecting — that a failure is never lost — is already guaranteed elsewhere. §7.2's notification centre keeps every `ready` and `failed` notice for the session, capped at 50, with an unread badge on the header bell; the task's own transition history is the durable record beyond that; and the failed task itself sits in the register wearing a red chip until somebody collects or retries it. A dismissed toast costs nothing.

## Decision

A failed toast auto-dismisses after **15 s**. A ready toast keeps its 6 s. Both show the remaining seconds on the card, as they already did, so the disappearance is never a surprise.

**Both countdowns hold while the toast is hovered or holds keyboard focus, and resume with the time that was left when the pointer or focus leaves.** This is the part that makes the timeout safe rather than merely shorter: a notice cannot vanish out from under someone who is reading it, and a keyboard user tabbing towards the dismiss button is not racing a clock. The hold is banked, not restarted — a toast paused with 8 s left resumes with 8 s, not 15.

15 s is two and a half times a success, chosen so that a wrapped engine `reason` — the longest thing a toast ever renders — can be read at a glance and still leave time to decide whether to tap through.

`Toast.tsx` no longer overrides its caller. The two durations are named constants at the one call site that uses them (`NotificationsLayer`), and an explicit `0` still means "never", so a future surface that genuinely needs a persistent notice can ask for one.

## Alternatives considered

- **Leave it as the brief says.** The docs are law, and this is a departure from one of them. Rejected because the brief's own §11 makes §§2–10 binding for *routes, states, the action matrix, store discipline, notification triggers and data shapes* — and a toast's dwell time is none of those. The trigger is untouched: a notice still fires on the first application of a `ready`/`failed` event, still deduplicates by event id, still fires for events recovered by replay. Only how long the card sits there changed.
- **A longer timeout — 30 s or a minute.** Rejected as the worst of both: long enough to still pile up during a retry storm, short enough to still be a timeout. If the answer is "some large number", the honest answer is persistence.
- **Persist only non-retryable failures.** Superficially attractive — those are the ones an operator must act on. Rejected because the distinction is already carried *inside* the toast (`retryable` / `not retryable`) and inside the detail screen; making it also govern the toast's lifetime would mean two failures that look nearly identical behave differently, which is a rule a user has to learn rather than notice.
- **Pause the countdown but keep persistence for failures.** This is the hold half without the timeout half, and it is what the brief effectively had. Rejected because the pause is what makes the timeout defensible, not a substitute for it.

## Consequences

- `frontend-brief.md` §7.1 is rewritten to state the new rule and to point here; `ui-spec.md` §7 records it in the design-gap table so a reader who remembers the old sentence lands on this record rather than assuming drift.
- The notification centre becomes materially more important: it is now the only place a dismissed failure can be re-read within the session. It was already built, already capped at 50, already badge-counted, and already linked from the bell on every screen — nothing about it changes, but §7.2's "convenience inbox" framing understates it slightly now, and the empty-state copy ("Nothing yet — you'll hear the moment a task finishes or fails") remains accurate.
- The toast's timer gains a paused state and therefore a small amount of state to get wrong: the banked remainder. `packages/web/test/Toast.test.tsx` pins the 6 s and 15 s lifetimes, the hold on hover and on focus, the resume-with-the-remainder, and that an explicit `0` still means never.
- Accessibility is unchanged in kind: failures still announce with `role="alert"` / `aria-live="assertive"`, and the announcement happens on arrival, not on dismissal. Nothing about the timing affects what a screen reader is told.
- If a future deployment ever does need a persistent failure notice — a shared operations wallboard, say — the capability is still there and needs a prop, not a rewrite.
