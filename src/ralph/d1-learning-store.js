const crypto = require('node:crypto');

// Cloudflare D1 learning store for the production (CI) brain.
//
// outcomes.jsonl is local + gitignored, so the GitHub Actions Aider workflow
// can't read the loop's learning history. This store persists it in Cloudflare
// D1 (schema: scripts/ralph/d1-schema.sql) so the model choice LEARNS across CI
// runs: read the best model for a context bucket, write each attempt's outcome.
//
// Pure HTTP via the D1 REST API; fetch is injectable so tests never hit network.

const D1_API = 'https://api.cloudflare.com/client/v4';

function config(env = process.env) {
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID || '',
    databaseId: env.RALPH_D1_DATABASE_ID || env.D1_DATABASE_ID || '',
    token: env.CLOUDFLARE_API_TOKEN || ''
  };
}

function isConfigured(env = process.env) {
  const c = config(env);
  return Boolean(c.accountId && c.databaseId && c.token);
}

async function query({ sql, params = [], env = process.env, fetchImpl = fetch } = {}) {
  const c = config(env);
  if (!c.accountId || !c.databaseId || !c.token) {
    return { ok: false, reason: 'd1_not_configured', results: [] };
  }
  try {
    const res = await fetchImpl(
      `${D1_API}/accounts/${c.accountId}/d1/database/${c.databaseId}/query`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, params })
      }
    );
    const json = await res.json();
    if (!json || json.success !== true) {
      return { ok: false, reason: 'd1_query_failed', errors: json && json.errors, results: [] };
    }
    // D1 returns result: [{ results: [...], success }]; flatten the first block.
    const block = Array.isArray(json.result) ? json.result[0] : json.result;
    return { ok: true, results: (block && block.results) || [] };
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error), results: [] };
  }
}

// Best model for a context bucket — highest success_rate, tie-broken by lowest
// cost-per-success, requiring minSamples. Mirrors routing-stats.recommendByContextBucket
// but over the D1 success_rate_by_bucket view. Returns null when no confident pick.
async function recommendForBucket({ contextBucket, minSamples = 2, env = process.env, fetchImpl = fetch } = {}) {
  if (!contextBucket) return null;
  const q = await query({
    sql: `SELECT model, executions, success_rate, cost_per_success_usd
          FROM success_rate_by_bucket
          WHERE context_bucket = ?
          ORDER BY success_rate DESC, COALESCE(cost_per_success_usd, 1e9) ASC`,
    params: [contextBucket],
    env,
    fetchImpl
  });
  if (!q.ok || !q.results.length) return null;
  const eligible = q.results.filter((r) => Number(r.executions) >= minSamples && r.cost_per_success_usd != null);
  const pool = eligible.length ? eligible : q.results.filter((r) => r.cost_per_success_usd != null);
  if (!pool.length) return null;
  const best = pool[0];
  return {
    model: best.model,
    success_rate: Number(best.success_rate),
    cost_per_success_usd: best.cost_per_success_usd == null ? null : Number(best.cost_per_success_usd),
    samples: Number(best.executions),
    low_confidence: Number(best.executions) < minSamples
  };
}

// Record one execution attempt: upsert the task, insert the execution row, and
// bump the routing_policy counters (Thompson priors stay; trials/successes grow).
async function recordOutcome({
  story_id,
  context_bucket = null,
  difficulty = null,
  task_kind = null,
  language = null,
  requested_paths = null,
  model,
  attempt_number = 0,
  succeeded = null, // true | false | null
  cost_usd = 0,
  failure_class = null,
  routing_source = null,
  role = 'executor',
  env = process.env,
  fetchImpl = fetch,
  idImpl = () => crypto.randomUUID()
} = {}) {
  if (!story_id || !model) return { ok: false, reason: 'story_id_and_model_required' };
  const succInt = succeeded === true ? 1 : succeeded === false ? 0 : null;
  const status = succeeded == null ? 'running' : succeeded ? 'succeeded' : 'failed';

  const upsertTask = await query({
    sql: `INSERT INTO tasks (story_id, difficulty, task_kind, language, requested_paths, context_bucket, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(story_id) DO UPDATE SET
            difficulty=COALESCE(excluded.difficulty, tasks.difficulty),
            context_bucket=COALESCE(excluded.context_bucket, tasks.context_bucket),
            updated_at=datetime('now')`,
    params: [story_id, difficulty, task_kind, language, requested_paths, context_bucket],
    env, fetchImpl
  });
  if (!upsertTask.ok) return { ok: false, reason: upsertTask.reason };

  const insExec = await query({
    sql: `INSERT INTO model_executions
            (id, story_id, attempt_number, model, role, succeeded, cost_usd, failure_class, routing_source, status, completed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    params: [idImpl(), story_id, attempt_number, model, role, succInt, cost_usd, failure_class, routing_source, status],
    env, fetchImpl
  });
  if (!insExec.ok) return { ok: false, reason: insExec.reason };

  if (context_bucket && succeeded != null) {
    await query({
      sql: `INSERT INTO routing_policy (context_bucket, model, trials, successes, cost_sum_usd, updated_at)
            VALUES (?, ?, 1, ?, ?, datetime('now'))
            ON CONFLICT(context_bucket, model) DO UPDATE SET
              trials = routing_policy.trials + 1,
              successes = routing_policy.successes + ?,
              cost_sum_usd = routing_policy.cost_sum_usd + ?,
              updated_at = datetime('now')`,
      params: [context_bucket, model, succInt, cost_usd, succInt, cost_usd],
      env, fetchImpl
    });
  }
  return { ok: true, status };
}

module.exports = { config, isConfigured, query, recommendForBucket, recordOutcome };
