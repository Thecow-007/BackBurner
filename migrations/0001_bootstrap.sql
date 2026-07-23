-- 0001_bootstrap.sql
--
-- Bootstrap migration (Phase 0). This intentionally creates no application
-- tables — `tasks`, `task_transitions` (Phase 2, @backburner/engine) and
-- `users` (Phase 3, @backburner/api) arrive in later, purpose-built numbered
-- migrations. Its only job is to fail fast, before any schema work begins,
-- if the target server does not meet BackBurner's hard requirement:
-- PostgreSQL 18+ with native `uuidv7()` (docs/architecture.md §4).
--
-- Migrations are append-only once committed (CLAUDE.md) — never edit this
-- file after it has been applied; add a new numbered migration instead.

DO $$
DECLARE
  pg_major int;
BEGIN
  SELECT current_setting('server_version_num')::int / 10000 INTO pg_major;

  IF pg_major < 18 THEN
    RAISE EXCEPTION
      'BackBurner requires PostgreSQL 18+ (native uuidv7()); found server_version_num=%',
      current_setting('server_version_num');
  END IF;

  BEGIN
    PERFORM uuidv7();
  EXCEPTION WHEN undefined_function THEN
    RAISE EXCEPTION
      'uuidv7() is not available on this server; BackBurner requires PostgreSQL 18+ with native uuidv7() support';
  END;
END
$$;
