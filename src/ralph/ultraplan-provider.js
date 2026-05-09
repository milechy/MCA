const { buildUltraPlan } = require('./ultraplan-runner');
const { canonicalizeUltraPlan } = require('./ultraplan-schema');
const { PLANNING_PROVIDERS, buildPlanningProviderConfig } = require('./provider-config');

const PROVIDER_MODES = Object.freeze({
  DETERMINISTIC: PLANNING_PROVIDERS.DETERMINISTIC,
  GEMINI: PLANNING_PROVIDERS.GEMINI,
  LLM: 'llm'
});

function normalizeProviderMode(value) {
  const mode = String(value || PROVIDER_MODES.DETERMINISTIC).trim().toLowerCase();
  if (mode === PROVIDER_MODES.LLM) return PROVIDER_MODES.GEMINI;
  if (mode === PROVIDER_MODES.GEMINI) return PROVIDER_MODES.GEMINI;
  return PROVIDER_MODES.DETERMINISTIC;
}

function deterministicUltraPlanProvider(story) {
  return {
    ok: true,
    provider: PROVIDER_MODES.DETERMINISTIC,
    role: 'planning',
    model: 'deterministic',
    plan: buildUltraPlan(story),
    fallback_used: false,
    reason: null
  };
}

function geminiProviderPreflight({ apiKey, enabled, env = process.env } = {}) {
  const config = buildPlanningProviderConfig({
    ...env,
    RALPH_PLANNING_PROVIDER: enabled ? PLANNING_PROVIDERS.GEMINI : PLANNING_PROVIDERS.DETERMINISTIC,
    GEMINI_API_KEY: apiKey || env.GEMINI_API_KEY || env.RALPH_GEMINI_API_KEY || env.RALPH_ULTRAPLAN_LLM_API_KEY || ''
  });
  if (config.provider !== PLANNING_PROVIDERS.GEMINI) return { ok: false, reason: 'gemini_provider_not_enabled', config };
  if (!config.api_key_present) return { ok: false, reason: 'gemini_api_key_missing', config };
  return { ok: true, reason: null, config };
}

function llmProviderPreflight({ apiKey = process.env.RALPH_ULTRAPLAN_LLM_API_KEY, enabled = process.env.RALPH_ULTRAPLAN_PROVIDER === 'llm' } = {}) {
  return geminiProviderPreflight({ apiKey, enabled });
}

async function generateUltraPlanWithProvider(story, {
  provider = null,
  providerMode = process.env.RALPH_PLANNING_PROVIDER || process.env.RALPH_ULTRAPLAN_PROVIDER || PROVIDER_MODES.DETERMINISTIC,
  apiKey = process.env.GEMINI_API_KEY || process.env.RALPH_GEMINI_API_KEY || process.env.RALPH_ULTRAPLAN_LLM_API_KEY,
  fallbackProvider = deterministicUltraPlanProvider,
  preflight = geminiProviderPreflight,
  providerConfig = null
} = {}) {
  const mode = normalizeProviderMode(providerMode);
  const fallback = fallbackProvider(story);
  if (!story || !story.story_id) {
    return {
      ok: false,
      stage: 'ultraplan_provider',
      reason: 'story_required',
      provider: mode,
      role: 'planning',
      fallback_used: false,
      execution_connected: false,
      commands_executed: [],
      repository_files_modified: []
    };
  }
  if (!provider || mode === PROVIDER_MODES.DETERMINISTIC) {
    return {
      ok: true,
      stage: 'ultraplan_provider',
      provider: PROVIDER_MODES.DETERMINISTIC,
      role: 'planning',
      model: fallback.model || 'deterministic',
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

  const check = preflight({ apiKey, enabled: mode === PROVIDER_MODES.GEMINI, env: process.env });
  const planningConfig = providerConfig || check.config || buildPlanningProviderConfig({ RALPH_PLANNING_PROVIDER: mode, GEMINI_API_KEY: apiKey || '' });
  if (!check.ok) {
    return {
      ok: true,
      stage: 'ultraplan_provider',
      provider: mode,
      role: 'planning',
      model: planningConfig.model || 'gemini',
      plan: fallback.plan,
      plan_hash: fallback.plan.plan_hash,
      fallback_used: true,
      fallback_reason: check.reason,
      provider_config: {
        role: planningConfig.role,
        provider: planningConfig.provider,
        model: planningConfig.model,
        api_key_present: planningConfig.api_key_present,
        api_key_preview: planningConfig.api_key_preview
      },
      execution_connected: false,
      commands_executed: [],
      repository_files_modified: [],
      next_action: 'run_ultraplan_runner_controls'
    };
  }

  try {
    const raw = await provider({ story, deterministic_plan: fallback.plan, apiKey, provider_config: planningConfig });
    const candidate = raw && raw.plan ? raw.plan : raw;
    const canonical = canonicalizeUltraPlan(candidate, fallback.plan);
    if (!canonical.ok) {
      return {
        ok: true,
        stage: 'ultraplan_provider',
        provider: mode,
        role: 'planning',
        model: planningConfig.model || 'gemini',
        plan: fallback.plan,
        plan_hash: fallback.plan.plan_hash,
        fallback_used: true,
        fallback_reason: canonical.reason,
        provider_config: {
          role: planningConfig.role,
          provider: planningConfig.provider,
          model: planningConfig.model,
          api_key_present: planningConfig.api_key_present,
          api_key_preview: planningConfig.api_key_preview
        },
        execution_connected: false,
        commands_executed: [],
        repository_files_modified: [],
        next_action: 'run_ultraplan_runner_controls'
      };
    }
    return {
      ok: true,
      stage: 'ultraplan_provider',
      provider: mode,
      role: 'planning',
      model: planningConfig.model || 'gemini',
      plan: canonical.plan,
      plan_hash: canonical.plan.plan_hash,
      fallback_used: false,
      reason: null,
      provider_config: {
        role: planningConfig.role,
        provider: planningConfig.provider,
        model: planningConfig.model,
        api_key_present: planningConfig.api_key_present,
        api_key_preview: planningConfig.api_key_preview
      },
      execution_connected: false,
      commands_executed: [],
      repository_files_modified: [],
      next_action: 'run_ultraplan_runner_controls'
    };
  } catch (error) {
    return {
      ok: true,
      stage: 'ultraplan_provider',
      provider: mode,
      role: 'planning',
      model: planningConfig.model || 'gemini',
      plan: fallback.plan,
      plan_hash: fallback.plan.plan_hash,
      fallback_used: true,
      fallback_reason: error.message || 'provider_failed',
      provider_config: {
        role: planningConfig.role,
        provider: planningConfig.provider,
        model: planningConfig.model,
        api_key_present: planningConfig.api_key_present,
        api_key_preview: planningConfig.api_key_preview
      },
      execution_connected: false,
      commands_executed: [],
      repository_files_modified: [],
      next_action: 'run_ultraplan_runner_controls'
    };
  }
}

module.exports = {
  PROVIDER_MODES,
  normalizeProviderMode,
  deterministicUltraPlanProvider,
  geminiProviderPreflight,
  llmProviderPreflight,
  generateUltraPlanWithProvider
};
