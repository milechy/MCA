-- Phase 11-A: routing-learning substrate.
--
-- Two-table design (per the Gemini cross-check in
-- docs/phase11-nemclaw-brain-readiness.md §8): separate the task CONTEXT
-- (what NemClaw saw when it decided) from each model EXECUTION (what
-- happened, the reward signal). One task can have many executions
-- (FIX_LOOP retries, model swaps), so they must be separate rows.
--
-- This migration is intentionally inert until Supabase is started
-- (`supabase start`) or a remote project is linked. The recorder
-- (src/ralph/task-outcome-recorder.js) dual-writes to a local JSONL sink
-- today and only talks to these tables when RALPH_OUTCOME_SINK=supabase.

create extension if not exists "uuid-ossp";

-- ----------------------------------------------------------------------
-- tasks: one row per story. The CONTEXT NemClaw routes on.
-- ----------------------------------------------------------------------
create table if not exists tasks (
  story_id        text primary key,
  -- context features (NemClaw's decision inputs; see §8.5 / §11-D)
  difficulty      text,            -- trivial|easy|medium|hard|architectural
  task_kind       text,            -- create|modify|refactor|bugfix|test_only|docs|mixed
  requested_paths int,             -- number of target files
  language        text,            -- primary language (js|ts|py|...)
  spec_chars      int,             -- requirement length in chars
  context_bucket  text,            -- discretized key for bandit grouping, e.g. "medium|modify|js|2f"
  -- planner's prediction (calibrated against outcome in 11-D)
  predicted_difficulty text,
  actual_difficulty    text,       -- back-computed from outcome (retries/cost), null until done
  -- bookkeeping
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists tasks_difficulty_idx on tasks (difficulty);
create index if not exists tasks_context_bucket_idx on tasks (context_bucket);

-- ----------------------------------------------------------------------
-- model_executions: one row per (story, attempt, model). The REWARD signal.
-- ----------------------------------------------------------------------
create table if not exists model_executions (
  -- deterministic id = uuid_v5(story_id + attempt + model) so a re-run of
  -- the same GitHub Actions job / daemon cycle upserts instead of double
  -- counting (idempotency; see §8.6 / Gemini #5).
  id              uuid primary key,
  story_id        text not null references tasks (story_id) on delete cascade,
  attempt_number  int  not null default 0,
  model           text not null,
  role            text not null default 'executor',  -- executor|planner|reviewer
  -- reward components
  succeeded       boolean,          -- gates passed AND PR merged (null = in-flight)
  fix_loop_attempts int,
  input_tokens    int,
  output_tokens   int,
  cost_usd        numeric(12,6),
  wall_seconds    int,
  failure_class   text,             -- coverage_incomplete|invalid_patch|api_key_missing|...
  routing_source  text,             -- difficulty_tier|story_explicit|auto_router|fallback_*
  -- lifecycle: written once at start (status=running) and again at finish
  -- so a zombie (Ctrl+C / runner kill) can be swept to failed(timeout).
  status          text not null default 'running',   -- running|succeeded|failed
  started_at      timestamptz not null default now(),
  completed_at    timestamptz,
  updated_at      timestamptz not null default now()
);

create index if not exists mx_story_idx     on model_executions (story_id);
create index if not exists mx_model_idx      on model_executions (model);
create index if not exists mx_status_idx     on model_executions (status);
create index if not exists mx_model_succ_idx on model_executions (model, succeeded);

-- ----------------------------------------------------------------------
-- routing_policy: the bandit posterior, model x context bucket.
-- Populated by aggregation today (11-B); consumed by the optional bandit
-- (11-E, sealed). Kept here so the schema is forward-compatible.
-- ----------------------------------------------------------------------
create table if not exists routing_policy (
  context_bucket  text not null,
  model           text not null,
  trials          int  not null default 0,
  successes       int  not null default 0,
  cost_sum_usd    numeric(14,6) not null default 0,
  -- prior seeded from the Phase 8 fixed ladder so cold-start isn't blind
  -- (see §8.2 #3). Beta(alpha_prior, beta_prior).
  alpha_prior     numeric(8,2) not null default 1,
  beta_prior      numeric(8,2) not null default 1,
  updated_at      timestamptz not null default now(),
  primary key (context_bucket, model)
);

-- ----------------------------------------------------------------------
-- success_rate_by_model: the 11-B view. "for a given difficulty+model,
-- what's the success rate and cost per success?" — answerable in one query
-- instead of the O(n*m) JSONL scan the old layout forced.
-- ----------------------------------------------------------------------
create or replace view success_rate_by_model as
select
  t.difficulty,
  e.model,
  count(*)                                            as executions,
  sum((e.succeeded is true)::int)                     as successes,
  round(avg((e.succeeded is true)::int)::numeric, 3)  as success_rate,
  round(sum(e.cost_usd)::numeric, 4)                  as total_cost_usd,
  round((sum(e.cost_usd) / nullif(sum((e.succeeded is true)::int), 0))::numeric, 4)
                                                      as cost_per_success_usd,
  round(avg(e.fix_loop_attempts)::numeric, 2)         as avg_fix_loops
from model_executions e
join tasks t on t.story_id = e.story_id
where e.role = 'executor' and e.status <> 'running'
group by t.difficulty, e.model
order by t.difficulty, success_rate desc;
