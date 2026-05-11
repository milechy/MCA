const { test, expect } = require('@playwright/test');

const {
  PLANNING_PROVIDERS,
  EXECUTION_PROVIDERS,
  EXECUTION_MEDIATORS,
  SECRET_ENV_KEYS,
  normalizePlanningProvider,
  normalizeExecutionProvider,
  normalizeMediator,
  buildProviderConfig,
  validateProviderConfig,
  safeProviderConfig
} = require('../../src/ralph/provider-config');

function secretFixture() {
  return ['sk', 'fixture', 'abcdefghijklmnopqrstuvwxyz'].join('-');
}

test('buildProviderConfig defaults to deterministic planning and Kimi through NemoClaw', () => {
  const config = buildProviderConfig({ env: {} });
  expect(config).toMatchObject({
    ok: true,
    stage: 'provider_config',
    planning: {
      provider: PLANNING_PROVIDERS.DETERMINISTIC,
      role: 'planning',
      model_family: 'deterministic',
      api_key_present: false,
      default_fallback_provider: PLANNING_PROVIDERS.DETERMINISTIC
    },
    execution: {
      provider: EXECUTION_PROVIDERS.KIMI,
      role: 'implementation_repair_code_generation',
      model_family: 'kimi',
      mediated_by: EXECUTION_MEDIATORS.NEMOCLAW,
      direct_policy_override_allowed: false,
      apply_allowed: false,
      commit_allowed: false,
      push_allowed: false,
      pr_allowed: false,
      deploy_allowed: false,
      migration_allowed: false,
      secret_access_allowed: false
    },
    execution_connected: false,
    commands_executed: [],
    repository_files_modified: []
  });
});

test('buildProviderConfig selects Gemini planning and redacts all secret values', () => {
  const geminiSecret = secretFixture();
  const kimiSecret = `${secretFixture()}-kimi`;
  const config = buildProviderConfig({
    env: {
      RALPH_PLANNING_PROVIDER: 'gemini',
      GEMINI_API_KEY: geminiSecret,
      RALPH_EXECUTION_PROVIDER: 'kimi',
      KIMI_API_KEY: kimiSecret,
      RALPH_EXECUTION_MEDIATOR: 'nemoclaw'
    }
  });
  const serialized = JSON.stringify(config);
  expect(config).toMatchObject({
    planning: {
      provider: PLANNING_PROVIDERS.GEMINI,
      api_key_env: SECRET_ENV_KEYS.GEMINI_API_KEY,
      api_key_present: true,
      api_key_value: '<set:redacted>'
    },
    execution: {
      provider: EXECUTION_PROVIDERS.KIMI,
      api_key_env: SECRET_ENV_KEYS.KIMI_API_KEY,
      api_key_present: true,
      api_key_value: '<set:redacted>',
      mediated_by: EXECUTION_MEDIATORS.NEMOCLAW
    }
  });
  expect(serialized).not.toContain(geminiSecret);
  expect(serialized).not.toContain(kimiSecret);
});

test('legacy RALPH_ULTRAPLAN_PROVIDER llm selects Gemini planning role', () => {
  const config = buildProviderConfig({ env: { RALPH_ULTRAPLAN_PROVIDER: 'llm', RALPH_ULTRAPLAN_LLM_API_KEY: 'legacy-secret' } });
  expect(config.planning).toMatchObject({
    provider: PLANNING_PROVIDERS.GEMINI,
    model_family: 'gemini',
    api_key_present: true,
    legacy_api_key_env: 'RALPH_ULTRAPLAN_LLM_API_KEY'
  });
  expect(JSON.stringify(config)).not.toContain('legacy-secret');
});

test('provider config validation rejects unsupported provider or non-NemoClaw execution mediator', () => {
  expect(validateProviderConfig(buildProviderConfig({ env: {} }))).toMatchObject({ ok: true });
  expect(validateProviderConfig({ planning: { provider: 'unknown' }, execution: { provider: 'kimi', mediated_by: 'nemoclaw' } })).toMatchObject({ ok: false, reason: 'planning_provider_not_allowed' });
  expect(validateProviderConfig({ planning: { provider: 'gemini' }, execution: { provider: 'unknown', mediated_by: 'nemoclaw' } })).toMatchObject({ ok: false, reason: 'execution_provider_not_allowed' });
  expect(validateProviderConfig({ planning: { provider: 'gemini' }, execution: { provider: 'kimi', mediated_by: 'none' } })).toMatchObject({ ok: false, reason: 'execution_mediator_must_be_nemoclaw' });
  expect(validateProviderConfig({ planning: { provider: 'gemini' }, execution: { provider: 'kimi', mediated_by: 'nemoclaw', direct_policy_override_allowed: true } })).toMatchObject({ ok: false, reason: 'execution_policy_override_not_allowed' });
});

test('safeProviderConfig keeps role boundary and never exposes secrets', () => {
  const geminiSecret = secretFixture();
  const config = buildProviderConfig({ env: { RALPH_PLANNING_PROVIDER: 'gemini', GEMINI_API_KEY: geminiSecret, KIMI_API_KEY: 'kimi-secret' } });
  const safe = safeProviderConfig(config);
  expect(safe).toMatchObject({
    stage: 'provider_config_safe_summary',
    planning: {
      provider: PLANNING_PROVIDERS.GEMINI,
      api_key_present: true,
      api_key_value: '<set:redacted>',
      default_fallback_provider: PLANNING_PROVIDERS.DETERMINISTIC
    },
    execution: {
      provider: EXECUTION_PROVIDERS.KIMI,
      mediated_by: EXECUTION_MEDIATORS.NEMOCLAW,
      direct_policy_override_allowed: false,
      apply_allowed: false,
      commit_allowed: false,
      push_allowed: false,
      pr_allowed: false,
      deploy_allowed: false,
      migration_allowed: false,
      secret_access_allowed: false
    }
  });
  expect(JSON.stringify(safe)).not.toContain(geminiSecret);
  expect(JSON.stringify(safe)).not.toContain('kimi-secret');
});

test('normalizers reject unsupported values', () => {
  expect(normalizePlanningProvider('gemini')).toBe(PLANNING_PROVIDERS.GEMINI);
  expect(normalizePlanningProvider('deterministic')).toBe(PLANNING_PROVIDERS.DETERMINISTIC);
  expect(normalizePlanningProvider('claude')).toBe(null);
  expect(normalizeExecutionProvider('kimi')).toBe(EXECUTION_PROVIDERS.KIMI);
  expect(normalizeExecutionProvider('gpt')).toBe(null);
  expect(normalizeMediator('nemoclaw')).toBe(EXECUTION_MEDIATORS.NEMOCLAW);
  expect(normalizeMediator('none')).toBe(null);
});
