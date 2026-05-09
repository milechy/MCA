const { test, expect } = require('@playwright/test');

const {
  PROVIDER_ROLES,
  PLANNING_PROVIDERS,
  EXECUTION_PROVIDERS,
  buildPlanningProviderConfig,
  buildExecutionProviderConfig,
  buildProviderConfig,
  redactSecret
} = require('../../src/ralph/provider-config');

function fakeSecret() {
  return ['sk', '-fixture-secret-value'].join('');
}

test('planning provider defaults to deterministic fallback without secrets', () => {
  const config = buildPlanningProviderConfig({});
  expect(config).toMatchObject({
    ok: true,
    role: PROVIDER_ROLES.PLANNING,
    provider: PLANNING_PROVIDERS.DETERMINISTIC,
    fallback_provider: PLANNING_PROVIDERS.DETERMINISTIC,
    fallback_allowed: true,
    api_key_present: false,
    api_key_preview: null,
    execution_allowed: false,
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    raw_secret_allowed: false
  });
});

test('Gemini planning provider requires API key but redacts it when present', () => {
  const secret = fakeSecret();
  const missing = buildPlanningProviderConfig({ RALPH_PLANNING_PROVIDER: 'gemini' });
  expect(missing).toMatchObject({ ok: false, provider: PLANNING_PROVIDERS.GEMINI, reason: 'gemini_api_key_missing' });

  const config = buildPlanningProviderConfig({ RALPH_PLANNING_PROVIDER: 'gemini', GEMINI_API_KEY: secret, RALPH_GEMINI_MODEL: 'gemini-test' });
  expect(config).toMatchObject({
    ok: true,
    role: PROVIDER_ROLES.PLANNING,
    provider: PLANNING_PROVIDERS.GEMINI,
    model: 'gemini-test',
    api_key_present: true,
    api_key_preview: '<redacted:set>',
    execution_allowed: false
  });
  expect(JSON.stringify(config)).not.toContain(secret);
});

test('Kimi execution provider is OpenCode through NemoClaw and cannot override policy', () => {
  const secret = fakeSecret();
  const config = buildExecutionProviderConfig({ KIMI_API_KEY: secret, KIMI_MODEL: 'kimi-test' });
  expect(config).toMatchObject({
    ok: true,
    role: PROVIDER_ROLES.EXECUTION,
    provider: EXECUTION_PROVIDERS.KIMI_OPENCODE,
    model: 'kimi-test',
    api_key_present: true,
    api_key_preview: '<redacted:set>',
    runtime_surface: 'opencode-through-nemoclaw',
    mediator: 'nemoclaw',
    opencode_runtime_mode: 'nemoclaw-mediated',
    policy_override_allowed: false,
    direct_execution_allowed: false,
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    unrestricted_shell_allowed: false,
    raw_secret_allowed: false
  });
  expect(JSON.stringify(config)).not.toContain(secret);
});

test('combined provider config records role boundary and never exposes raw secrets', () => {
  const gemini = fakeSecret();
  const kimi = 'kimi-secret-value';
  const config = buildProviderConfig({ RALPH_PLANNING_PROVIDER: 'gemini', GEMINI_API_KEY: gemini, KIMI_API_KEY: kimi });
  expect(config).toMatchObject({
    ok: true,
    stage: 'provider_config',
    role_boundary: {
      policy_owner: 'ralph-nemoclaw',
      kimi_policy_override_allowed: false,
      gemini_execution_allowed: false,
      model_direct_apply_allowed: false,
      model_direct_commit_allowed: false,
      model_direct_push_allowed: false,
      model_direct_pr_allowed: false,
      model_direct_deploy_allowed: false,
      model_direct_migration_allowed: false
    },
    execution_connected: false,
    commands_executed: [],
    repository_files_modified: []
  });
  const serialized = JSON.stringify(config);
  expect(serialized).not.toContain(gemini);
  expect(serialized).not.toContain(kimi);
});

test('redactSecret never returns raw secret material', () => {
  expect(redactSecret(null)).toBe(null);
  expect(redactSecret(fakeSecret())).toBe('<redacted:set>');
});
