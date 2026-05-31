-- Cloudflare D1 (SQLite) port of supabase/migrations/20260529000000_phase11a_routing_learning.sql.
-- The routing-learning store the production Aider workflow reads (which model to
-- pick for a context bucket) and writes (each attempt's outcome) so the brain's
-- model choice LEARNS across CI runs instead of being a fixed Claude default.

CREATE TABLE IF NOT EXISTS tasks (
  story_id        TEXT PRIMARY KEY,
  difficulty      TEXT,
  task_kind       TEXT,
  requested_paths INTEGER,
  language        TEXT,
  spec_chars      INTEGER,
  context_bucket  TEXT,
  predicted_difficulty TEXT,
  actual_difficulty    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS tasks_difficulty_idx     ON tasks (difficulty);
CREATE INDEX IF NOT EXISTS tasks_context_bucket_idx ON tasks (context_bucket);

CREATE TABLE IF NOT EXISTS model_executions (
  id              TEXT PRIMARY KEY,
  story_id        TEXT NOT NULL,
  attempt_number  INTEGER NOT NULL DEFAULT 0,
  model           TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'executor',
  succeeded       INTEGER,            -- 1 / 0 / NULL (in-flight)
  fix_loop_attempts INTEGER,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_usd        REAL,
  wall_seconds    INTEGER,
  failure_class   TEXT,
  routing_source  TEXT,
  status          TEXT NOT NULL DEFAULT 'running',
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS mx_story_idx     ON model_executions (story_id);
CREATE INDEX IF NOT EXISTS mx_model_idx     ON model_executions (model);
CREATE INDEX IF NOT EXISTS mx_status_idx    ON model_executions (status);
CREATE INDEX IF NOT EXISTS mx_bucket_idx    ON model_executions (story_id, model);

-- Thompson-sampling-ready policy table (alpha/beta priors), updated per outcome.
CREATE TABLE IF NOT EXISTS routing_policy (
  context_bucket  TEXT NOT NULL,
  model           TEXT NOT NULL,
  trials          INTEGER NOT NULL DEFAULT 0,
  successes       INTEGER NOT NULL DEFAULT 0,
  cost_sum_usd    REAL NOT NULL DEFAULT 0,
  alpha_prior     REAL NOT NULL DEFAULT 1,
  beta_prior      REAL NOT NULL DEFAULT 1,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (context_bucket, model)
);

-- Recommendation source keyed on the full context bucket × model (what the
-- brain picks "the best LLM for THIS function" from). success_rate then
-- cost-per-success, mirroring routing-stats.recommendByContextBucket.
DROP VIEW IF EXISTS success_rate_by_bucket;
CREATE VIEW success_rate_by_bucket AS
SELECT
  t.context_bucket,
  e.model,
  COUNT(*)                                            AS executions,
  SUM(CASE WHEN e.succeeded = 1 THEN 1 ELSE 0 END)    AS successes,
  ROUND(AVG(CASE WHEN e.succeeded = 1 THEN 1.0 ELSE 0.0 END), 3) AS success_rate,
  ROUND(SUM(COALESCE(e.cost_usd, 0)), 4)              AS total_cost_usd,
  CASE WHEN SUM(CASE WHEN e.succeeded = 1 THEN 1 ELSE 0 END) > 0
       THEN ROUND(SUM(COALESCE(e.cost_usd, 0)) / SUM(CASE WHEN e.succeeded = 1 THEN 1 ELSE 0 END), 4)
       ELSE NULL END                                  AS cost_per_success_usd,
  ROUND(AVG(COALESCE(e.fix_loop_attempts, 0)), 2)     AS avg_fix_loops
FROM model_executions e
JOIN tasks t ON t.story_id = e.story_id
WHERE e.role = 'executor' AND e.status <> 'running'
GROUP BY t.context_bucket, e.model;
