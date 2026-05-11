const { buildUltraPlan } = require('./ultraplan-runner');
const { canonicalizeUltraPlan } = require('./ultraplan-schema');
const { PLANNING_PROVIDERS, buildProviderConfig } = require('./provider-config');

const PROVIDER_MODES = Object.freeze({
  DETERMINISTIC: PLANNING_PROVIDERS.DETERMINISTIC,
  GEMINI: PLANNING_PROVIDERS.GEMINI,
  LLM: 'llm'
});

function providerModeToPlanningProvider(providerMode) {
  if (providerMode === PROVIDER_MODES.LLM) return PROVIDER_MODES.GEMINI;
  if (providerMode === PROVIDER_MODES.GEMINI) return PROVIDER_MODES.GEMINI;
  return PROVIDER_MODES.DETERMINISTIC;
}

function deterministicUltraPlanProvider(story) {
  return {
    ok: true,
    provider: PROVIDER_MODES.DETERMINISTIC,
    planning_provider: PROVIDER_MODES.DETERMINISTIC,
    plan: buildUltraPlan(story),
    fallback_used: false,
    reason: null
  };
}

function geminiProviderPreflight({ apiKey, enabled = true } = {}) {
  if (!enabled) return { ok: false, reason: 'gemini_provider_not_enabled' };
  if (!apiKey) return { ok: false, reason: 'gemini_api_key_missing' };
  return { ok: true, reason: null };
}

function llmProviderPreflight({ apiKey = process.env.GEMINI_API_KEY || process.env.RALPH_ULTRAPLAN_LLM_API_KEY, enabled = ['gemini', 'llm'].includes(process.env.RALPH_PLANNING_PROVIDER || process.env.RALPH_ULTRAPLAN_PROVIDER) } = {}) {
  return geminiProviderPreflight({ apiKey, enabled });
}

function providerFailureResult({ story, providerMode, planningProvider, fallback, fallback_reason }) {
  return {
    ok: true,
    stage: 'ultraplan_provider',
    provider: providerMode,
    planning_provider: planningProvider,
    plan: fallback.plan,
    plan_hash: fallback.plan.plan_hash,
    fallback_used: true,
    fallback_reason,
    execution_connected: false,
    commands_executed: [],
    repository_files_modified: [],
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    next_action: 'run_ultraplan_runner_controls'
  };
}

async function generateUltraPlanWithProvider(story, {
  provider = null,
  providerMode = process.env.RALPH_PLANNING_PROVIDER || process.env.RALPH_ULTRAPLAN_PROVIDER || PROVIDER_MODES.DETERMINISTIC,
  apiKey = process.env.GEMINI_API_KEY || process.env.RALPH_ULTRAPLAN_LLM_API_KEY,
  fallbackProvider = deterministicUltraPlanProvider,
  preflight = geminiProviderPreflight,
  providerConfig = buildProviderConfig()
} = {}) {
  const planningProvider = providerModeToPlanningProvider(providerMode);
  const fallback = fallbackProvider(story);
  if (!story || !story.story_id) {
    return {
      ok: false,
      stage: 'ultraplan_provider',
      reason: 'story_required',
      provider: providerMode,
      planning_provider: planningProvider,
      fallback_used: false,
      execution_connected: false,
      commands_executed: [],
      repository_files_modified: []
    };
  }
  if (!provider || planningProvider === PROVIDER_MODES.DETERMINISTIC) {
    return {
      ok: true,
      stage: 'ultraplan_provider',
      provider: PROVIDER_MODES.DETERMINISTIC,
      planning_provider: PROVIDER_MODES.DETERMINISTIC,
      provider_config: providerConfig,
      plan: fallback.plan,
      plan_hash: fallback.plan.plan_hash,
      fallback_used: false,
      reason: null,
      execution_connected: false,
      commands_executed: [],
      repository_files_modified: [],
      apply_allowed: false,
      commit_allowed: false,
      push_allowed: false,
      pr_allowed: false,
      merge_allowed: false,
      deploy_allowed: false,
      migration_allowed: false,
      next_action: 'run_ultraplan_runner_controls'
    };
  }

  const check = preflight({ apiKey, enabled: planningProvider === PROVIDER_MODES.GEMINI });
  if (!check.ok) {
    return providerFailureResult({ story, providerMode, planningProvider, fallback, fallback_reason: check.reason });
  }

  try {
    const raw = await provider({ story, deterministic_plan: fallback.plan, apiKey, provider_config: providerConfig });
    const candidate = raw && raw.plan ? raw.plan : raw;
    const canonical = canonicalizeUltraPlan(candidate, fallback.plan);
    if (!canonical.ok) {
      return providerFailureResult({ story, providerMode, planningProvider, fallback, fallback_reason: canonical.reason });
    }
    return {
      ok: true,
      stage: 'ultraplan_provider',
      provider: PROVIDER_MODES.GEMINI,
      planning_provider: PROVIDER_MODES.GEMINI,
      provider_config: providerConfig,
      plan: canonical.plan,
      plan_hash: canonical.plan.plan_hash,
      fallback_used: false,
      reason: null,
      execution_connected: false,
      commands_executed: [],
      repository_files_modified: [],
      apply_allowed: false,
      commit_allowed: false,
      push_allowed: false,
      pr_allowed: false,
      merge_allowed: false,
      deploy_allowed: false,
      migration_allowed: false,
      next_action: 'run_ultraplan_runner_controls'
    };
  } catch (error) {
    return providerFailureResult({ story, providerMode, planningProvider, fallback, fallback_reason: error.message || 'gemini_provider_failed' });
  }
}

module.exports = {
  PROVIDER_MODES,
  providerModeToPlanningProvider,
  deterministicUltraPlanProvider,
  geminiProviderPreflight,
  llmProviderPreflight,
  generateUltraPlanWithProvider
};
