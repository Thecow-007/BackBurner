# 0009. Raw SQL over an ORM

Status: Accepted — 2026-07-21

## Context

The load-bearing behavior in this system *is* SQL: a partial unique index enforcing the handle invariant, advisory locks serializing allocation, compare-and-swap `UPDATE`s implementing the state machine, a `FOR UPDATE SKIP LOCKED` claim query, and a transactional outbox insert. The schema is three tables and will not churn. The question is whether an abstraction layer between intent and statement earns its keep when the statements are the design.

## Decision

The `pg` driver and hand-written SQL, throughout. Migrations are numbered `.sql` files in the root `migrations/` directory, applied by a small cross-platform runner (`scripts/migrate.mjs`) that tracks applied files in a `schema_migrations` table, runs idempotently, and executes on production start and on demand in development and tests.

## Alternatives considered

- **Prisma.** Excellent developer experience for CRUD-shaped applications. But partial indexes, advisory locks, and CAS updates all route through raw-SQL escape hatches anyway, at which point the schema DSL and client are overhead around the queries that matter — and the migration engine hides exactly the DDL a reviewer should read.
- **Drizzle.** Much closer to SQL and genuinely lightweight; the most credible alternative. Still one translation layer to audit between what was written and what runs, for a project whose hardest bugs would live precisely in that gap. With ~15 static queries, the layer protects nothing.
- **Knex or another query builder.** A builder shines when queries are composed dynamically. These queries are fixed strings with parameters; a builder adds a dialect to learn and review without removing any real duplication.
- **Entity-tracking ORMs (TypeORM, Sequelize).** Unit-of-work semantics actively fight this design: `save()` obscures the `WHERE status = $expected` clause that makes every transition safe. The abstraction is not just unhelpful here — it is a hazard.

## Consequences

- Every statement in the repository is exactly the statement Postgres executes; the migration files read as the design document they effectively are.
- No impedance mismatch around the queries that carry the correctness burden — CAS conditions, lock ordering, and index predicates are visible at every call site.
- Costs accepted: no generated result types (mitigated by thin per-table row-mapper functions behind a narrow db module), and no automatic drift detection or rollback generation — reasonable to forgo for a fixed three-table schema, and re-evaluable if the schema ever starts moving.
- The migration runner is a small amount of owned code, in exchange for identical behavior across Windows, Linux, CI, and Codespaces with zero native dependencies.
