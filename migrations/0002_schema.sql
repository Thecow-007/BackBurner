-- 0002_schema.sql
--
-- Application schema (Phase 2, @backburner/engine + Phase 3, @backburner/api).
-- FK-safe order: users, then tasks (references users), then task_transitions
-- (references tasks). Verbatim from docs/architecture.md §4.
--
-- Migrations are append-only once committed (CLAUDE.md) — never edit this
-- file after it has been applied; add a new numbered migration instead.

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  name         text NOT NULL,
  api_key_hash text NOT NULL UNIQUE,          -- sha256 hex; raw key shown once at seed time
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id      uuid NOT NULL REFERENCES users(id),
  lane         text NOT NULL,
  handle_num   int  NOT NULL CHECK (handle_num >= 1),
  params       jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL CHECK (status IN ('queued','running','ready','failed','cancelled')),
  result       jsonb,
  error        jsonb,                          -- { reason, retryable }
  attempts     int  NOT NULL DEFAULT 0,
  max_attempts int  NOT NULL DEFAULT 3,
  collected    bool NOT NULL DEFAULT false,
  seeded       bool NOT NULL DEFAULT false,
  enqueued_at  timestamptz NOT NULL DEFAULT now(),  -- reset on EVERY entry to queued
  run_after    timestamptz,                         -- backoff; also powers delayed-jobs extension
  started_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()   -- maintained by app code in each UPDATE
);

CREATE UNIQUE INDEX one_active_handle ON tasks (user_id, lane, handle_num)
  WHERE status IN ('queued','running')
     OR (status IN ('ready','failed') AND NOT collected);

CREATE INDEX dispatch_scan ON tasks (enqueued_at, id) WHERE status = 'queued';
CREATE INDEX tasks_list ON tasks (user_id, created_at DESC);

CREATE TABLE task_transitions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- doubles as SSE event id / cursor
  task_id     uuid NOT NULL REFERENCES tasks(id),
  user_id     uuid NOT NULL,                   -- denormalized for per-user replay
  event_type  text NOT NULL,                   -- accepted|running|ready|failed|cancelled|retrying|collected
  from_status text,
  to_status   text,
  at          timestamptz NOT NULL DEFAULT now(),
  meta        jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX transitions_by_task ON task_transitions (task_id, id);
CREATE INDEX transitions_by_user ON task_transitions (user_id, id);
