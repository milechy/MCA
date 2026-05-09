const { buildUltraPlan } = require('./ultraplan-runner');
const { canonicalizeUltraPlan } = require('./ultraplan-schema');

const PROVIDER_MODES = Object.freeze({
  DETERMINISTIC: 'deterministic',
  LLM: 'llm'
});

function deterministicUltraPlanProvider(story) {
  return {
    ok: true,
    provider: PROVIDER_MODES.DETERMINISTIC,
    plan: buildUltraPlan(story),
    fallback_used: false,
    reason: null
  };
}

function llmProviderPreflight({ apiKey = process.env.RALPH_ULTRAPLAN_LLM_API_KEY, enabled = process.env.RALPH_ULTRAPLAN_PROVIDER === 'llm' } = {}) {
  if (!enabled) return { ok: false, reason: 'llm_provider_not_enabled' };
  if (!apiKey) return { ok: false, reason: 'llm_api_key_missing' };
  return { ok: true, reason: null };
}

async function generateUltraPlanWithProvider(story, {
  provider = null,
  providerMode = process.env.RALPH_ULTRAPLAN_PROVIDER || PROVIDER_MODES.DETERMINISTIC,
  apiKey = process.env.RALPH_ULTRAPLAN_LLM_API_KEY,
  fallbackProvider = deterministicUltraPlanProvider,
  preflight = llmProviderPreflight
} = {}) {
  const fallback = fallbackProvider(story);
  if (!story || !story.story_id) {
    return {
      ok: false,
      stage: 'ultraplan_provider',
      reason: 'story_required',
      provider: providerMode,
      fallback_used: false,
      execution_connected: false,
      commands_executed: [],
      repository_files_modified: []
    };
  }
  if (!provider || providerMode === PROVIDER_MODES.DETERMINISTIC) {
    return {
      ok: true,
      stage: 'ultraplan_provider',
      provider: PROVIDER_MODES.DETERMINISTIC,
      plan: fallback.plan,
      plan_hash: fallback.plan.plan_hash,
      fallback_used: false,
      reason: null,
      execution_connected: false,
      commands_executed: [],
      repository_files_modified: [],
      next_action: 'run_ultraplan_runner_controls'
    };
  }

  const check = preflight({ apiKey, enabled: providerMode === PROVIDER_MODES.LLM });
  if (!check.ok) {
    return {
      ok: true,
      stage: 'ultraplan_provider',
      provider: providerMode,
      plan: fallback.plan,
      plan_hash: fallback.plan.plan_hash,
      fallback_used: true,
      fallback_reason: check.reason,
      execution_connected: false,
      commands_executed: [],
      repository_files_modified: [],
      next_action: 'run_ultraplan_runner_controls'
    };
  }

  try {
    const raw = await provider({ story, deterministic_plan: fallback.plan, apiKey });
    const candidate = raw && raw.plan ? raw.plan : raw;
    const canonical = canonicalizeUltraPlan(candidate, fallback.plan);
    if (!canonical.ok) {
      return {
        ok: true,
        stage: 'ultraplan_provider',
        provider: providerMode,
        plan: fallback.plan,
        plan_hash: fallback.plan.plan_hash,
        fallback_used: true,
        fallback_reason: canonical.reason,
        execution_connected: false,
        commands_executed: [],
        repository_files_modified: [],
        next_action: 'run_ultraplan_runner_controls'
      };
    }
    return {
      ok: true,
      stage: 'ultraplan_provider',
      provider: providerMode,
      plan: canonical.plan,
      plan_hash: canonical.plan.plan_hash,
      fallback_used: false,
      reason: null,
      execution_connected: false,
      commands_executed: [],
      repository_files_modified: [],
      next_action: 'run_ultraplan_runner_controls'
    };
  } catch (error) {
    return {
      ok: true,
      stage: 'ultraplan_provider',
      provider: providerMode,
      plan: fallback.plan,
      plan_hash: fallback.plan.plan_hash,
      fallback_used: true,
      fallback_reason: error.message || 'provider_failed',
      execution_connected: false,
      commands_executed: [],
      repository_files_modified: [],
      next_action: 'run_ultraplan_runner_controls'
    };
  }
}

module.exports = {
  PROVIDER_MODES,
  deterministicUltraPlanProvider,
  llmProviderPreflight,
  generateUltraPlanWithProvider
};
