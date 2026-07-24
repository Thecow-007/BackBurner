# Architecture Decision Records

This directory records the significant, hard-to-reverse design decisions behind BackBurner. Each record captures the context at the time of the decision, the alternatives that were genuinely on the table, and the consequences we accepted — so a reviewer can follow the reasoning, not just the result.

Records follow one template: **Status / Context / Decision / Alternatives considered / Consequences**. They are numbered in the order the decisions were made and are never rewritten after acceptance; a superseding decision gets a new record that links back.

Where a record extends or resolves an ambiguity in the assessment spec ([`docs/assessment-background-job-runner.pdf`](../assessment-background-job-runner.pdf)), the spec's fixed shapes remain byte-for-byte and the extension is additive — see [ADR 0010](0010-additive-api-extension-policy.md) for the governing policy.

## Index

| # | Decision | Status |
|---|----------|--------|
| [0001](0001-postgres-as-handle-allocator.md) | Postgres as the handle allocator | Accepted |
| [0002](0002-uuidv7-primary-key-handle-as-lease.md) | UUIDv7 primary key; the handle is a lease | Accepted |
| [0003](0003-event-driven-push-dispatch.md) | Event-driven push dispatch | Accepted |
| [0004](0004-transitions-table-as-history-outbox-and-sse-replay.md) | One transitions table as history, outbox, and SSE replay log | Accepted |
| [0005](0005-cas-state-machine-plus-advisory-lock.md) | CAS state machine plus advisory-lock allocation | Accepted |
| [0006](0006-at-least-once-recovery-attempts-at-claim.md) | At-least-once recovery; attempts counted at claim | Accepted |
| [0007](0007-sse-over-websockets.md) | Server-sent events over WebSockets | Accepted |
| [0008](0008-black-box-criteria-tests.md) | Black-box tests mapped 1:1 to the success criteria | Accepted |
| [0009](0009-raw-sql-over-orm.md) | Raw SQL over an ORM | Accepted |
| [0010](0010-additive-api-extension-policy.md) | Additive API extension policy | Accepted |
| [0011](0011-fastify-over-express.md) | Fastify over Express | Accepted |
| [0012](0012-npm-workspaces-module-boundary.md) | npm workspaces as the module boundary | Accepted |
| [0013](0013-failed-tasks-are-collectable.md) | Failed tasks are collectable | Accepted |
| [0014](0014-typescript-project-references-build-typecheck.md) | TypeScript project references for build and typecheck | Accepted |
| [0015](0015-e2e-harness-additive-helpers.md) | Additive e2e harness helpers beyond the test-plan surface | Accepted |
| [0016](0016-single-schema-migration.md) | One migration creates the full shared schema | Accepted |
| [0017](0017-mock-params-normalized-by-caller.md) | Mock-worker param defaults filled by the caller, not the engine core | Accepted |
