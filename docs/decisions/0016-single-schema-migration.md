# 0016. One migration creates the full shared schema

Status: Accepted — 2026-07-23

## Context

Migrations are a single ordered, append-only stream at the repo root ([architecture.md](../architecture.md) §3), applied in numbered order. The bootstrap migration's comment sketched a plan in which Phase 2 would add `tasks`/`task_transitions` and Phase 3 would add `users` in separate numbered migrations.

That order cannot work. `tasks.user_id` is declared `REFERENCES users(id)` (architecture §4), and PostgreSQL requires the referenced table to exist before the referencing one is created. A Phase-2 `tasks` migration preceding a Phase-3 `users` migration would fail on application — the foreign key would point at a table that does not yet exist.

Architecture §4 presents `users`, `tasks`, and `task_transitions` as one coherent schema block, and §3 is explicit that table *ownership* — which package may run SQL against which table — is a code-level rule, not a migration-level one.

## Decision

A single migration, `0002_schema.sql`, creates the entire application schema in FK-safe order: `users`, then `tasks` (with `one_active_handle` and the dispatch/list indexes), then `task_transitions` (with its indexes) — verbatim from architecture §4. The API package ships no migration of its own.

Ownership is enforced where the docs say it lives — in code. The engine is the only package that runs SQL against `tasks`/`task_transitions`; the API's only non-engine SQL is against `users` (auth) and `schema_migrations` (boot-time migration verification).

## Alternatives considered

- **Users migration first (`0002` users, `0003` engine tables).** Keeps a standalone users migration, but inverts the phase→migration mapping and splits one coherent schema across two files for no functional gain.
- **Create `tasks` without the FK, add the constraint later.** Splits the `tasks` definition across migrations and leaves a window in which the foreign key is absent — strictly worse than defining it correctly once.

## Consequences

- The foreign key is valid at creation time; `one_active_handle` and every index exist from the first schema migration. The schema matches architecture §4 line for line.
- The bootstrap comment's "Phase 3 owns a users migration" hint is not followed; the boundary it was protecting is upheld in code instead, and verified (the API contains no SQL touching engine-owned tables).
- Migrations remain append-only: this structure is locked once committed. Any later schema change is a new numbered migration, never an edit to this one.
