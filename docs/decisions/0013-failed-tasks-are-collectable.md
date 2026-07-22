# 0013. Failed tasks are collectable

Status: Accepted — 2026-07-22

## Context

Handles recycle "once a job is collected or cancelled" (the spec's own recycling rule), and cancel is specified narrowly — legal only for "a queued or running task." A `failed` task has already stopped running: cancel's spec-fixed state set does not reach it, and the spec never describes an auto-collect for failures ("a failed job is not silently collected" — success criterion 5). Put those three sentences together and a failed task's handle has no spec-described release path at all.

The spec's handles section resolves this if read literally rather than skimmed: it defines active as "still queued, running, or **finished-but-uncollected**." That phrase only parses if "finished" spans both terminal outcomes — a job that finished by succeeding and a job that finished by failing are both, unambiguously, *finished*. Read that way, `failed` was never an exception to be patched; it was always inside "finished-but-uncollected," and the release path was collect all along, exactly the one `ready` already uses. The dashboard section reinforces this by describing operators who "collect a finished result" — not "a successful result."

## Decision

`failed` joins `ready` as a collectable, finished-but-uncollected state. `GET /tasks/{handle}/result` is legal from either: it flips `collected` to `true`, frees the handle, and emits `collected` — populating `result` when the task is `ready` and `error` when it is `failed`, per the existing serializer visibility rule. Collecting a failed task never touches the stored error; it is a pure acknowledge-and-release action, and the failed task's error was already fully visible before collection (the serializer shows `error` on any `failed` task regardless of `collected`).

Cancel is restored to the spec's exact words: legal only from `queued` or `running`. It is no longer extended to `failed` — there is nothing left to cancel in a task whose worker has already stopped, and "cancel" was always the wrong verb for acknowledging a result that already landed. Retry keeps its existing shape but gains one guard: legal only from `failed` **and** while uncollected — once an operator has collected a failed task, that acknowledgment is final, and retry is retired for good.

The `one_active_handle` predicate now reads `status IN ('queued','running') OR (status IN ('ready','failed') AND NOT collected)` — the spec's own "queued, running, or finished-but-uncollected" restated in SQL, with no special-casing for which terminal outcome "finished" describes.

## Alternatives considered

- **Extend cancel to `failed` instead** (the prior design). Technically closes the handle-leak, but deviates from the spec's own cancel constraint for no compensating benefit, and "cancel" is semantically wrong for work that has already stopped running — there is no worker left to abort. It also duplicates a verb: once collect covers `failed`, cancel-from-failed does the same job with worse vocabulary.
- **`failed` frees its handle automatically**, with no operator action required. Rejected on two grounds: it directly contradicts the spec's "finished-but-uncollected" language, which implies uncollected `failed` tasks are supposed to keep holding their handle, and it strips the operator of the chance to see and act on a failure before its handle is silently recycled out from under them — losing exactly the operator control the dashboard's design exists to provide.

## Consequences

- Cancel is byte-for-byte spec again: legal from `queued` or `running`, full stop, with no extension badge and no rationale needed beyond quoting the spec.
- The operator's two verbs on a failed task are exactly retry (while uncollected) and collect/acknowledge — the same two verbs `ready` offers, described the same way.
- Retry is retired the moment a failed task is collected, so an operator's acknowledgment is a genuine, irreversible checkpoint, not a state that quietly still accepts a stale retry.
- The active-handle predicate mirrors the spec's own wording verbatim instead of carrying a bolted-on third state, which is one less thing a future reader has to independently verify is correct.
- The pattern matches established prior art: Celery's `result.get()` and Temporal's result-fetch APIs return a stored failure through the identical call path as a success; Sidekiq's Dead set offers exactly two operator verbs, retry or delete/acknowledge. No mainstream job runner treats "cancel" as the way to dismiss work that already finished, successfully or not.
