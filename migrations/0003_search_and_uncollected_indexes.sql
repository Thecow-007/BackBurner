-- 0003_search_and_uncollected_indexes.sql
--
-- Supporting indexes for the two `GET /tasks` filters added in ADR 0022:
-- `?uncollected=true` and `?q=`. No schema change — indexes only, so this
-- migration is safe to apply to a populated database.
--
-- Every statement is `IF NOT EXISTS`: the runner already skips an applied
-- version by checksum, but a half-applied or hand-run file must never turn a
-- re-run into a hard failure.
--
-- Migrations are append-only once committed (CLAUDE.md) — never edit this
-- file after it has been applied; add a new numbered migration instead.

-- `?uncollected=true` restricts to the EXACT predicate behind the
-- `counts.uncollected` badge that opens it. A partial index on that predicate
-- serves the filtered list directly: index scan in `created_at DESC` order,
-- no recheck, no sort. The predicate is spelled here exactly as
-- `filters.ts`'s UNCOLLECTED_PREDICATE spells it so the planner can prove
-- the match.
CREATE INDEX IF NOT EXISTS tasks_uncollected ON tasks (user_id, created_at DESC)
  WHERE status IN ('ready','failed') AND collected = false;

-- `?q=` matches a task's DERIVED handle (`<lane>-<handle_num>`), which is
-- never stored as a string (architecture §5) — so the equality and
-- prefix scans need an expression index over the same expression the query
-- builds. `text_pattern_ops` is what makes `LIKE 'scrape-1%'` index-usable
-- regardless of the database's collation.
CREATE INDEX IF NOT EXISTS tasks_handle_search
  ON tasks (user_id, (lower(lane || '-' || handle_num::text)) text_pattern_ops);
