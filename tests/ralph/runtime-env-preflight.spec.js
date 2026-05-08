const { test, expect } = require('@playwright/test');

const { SECRET_SCOPES } = require('../../src/ralph/secrets-policy');
const { normalizeEnvKey, envReference, normalizeEnvReferences, referenceToEnvKey, verifyRuntimeEnvInjection } = require('../../src/ralph/runtime-env-preflight');

test('runtime env helpers normalize env references only', () => {
  expect(normalizeEnvKey('TELEGRAM_BOT_TOKEN')).toBe('TELEGRAM_BOT_TOKEN');
  expect(normalizeEnvKey('bad-key')).toBe(null);
  expect(envReference('TELEGRAM_BOT_TOKEN')).toBe('env:TELEGRAM_BOT_TOKEN');
  expect(normalizeEnvReferences({ references: ['vault:LOCAL_TOKEN'], required_env_keys: ['TELEGRAM_BOT_TOKEN', 'bad-key'] })).toEqual(['vault:LOCAL_TOKEN', 'env:TELEGRAM_BOT_TOKEN']);
  expect(referenceToEnvKey('env:TELEGRAM_BOT_TOKEN')).toBe('TELEGRAM_BOT_TOKEN');
  expect(referenceToEnvKey('vault:TELEGRAM_BOT_TOKEN')).toBe(null);
});

test('verifyRuntimeEnvInjection blocks literal and invalid references', () => {
  expect(verifyRuntimeEnvInjection({ references: [['env:BAD', ['12345678', ':', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'].join('')].join('_')] })).toMatchObject({ ok: false, reason: 'literal_secret_value_not_allowed', injection_allowed: false });
  expect(verifyRuntimeEnvInjection({ references: ['plain-token'] })).toMatchObject({ ok: false, reason: 'secret_reference_invalid', injection_allowed: false });
});

test('verifyRuntimeEnvInjection blocks missing required env reference', () => {
  expect(verifyRuntimeEnvInjection({ scope: SECRET_SCOPES.LOCAL_ONLY, required_env_keys: ['TELEGRAM_BOT_TOKEN'], env: {} })).toMatchObject({
    ok: false,
    reason: 'required_env_reference_missing',
    missing_env_keys: ['TELEGRAM_BOT_TOKEN'],
    display_allowed: false,
    persistence_allowed: false,
    log_values_allowed: false
  });
});

test('verifyRuntimeEnvInjection allows present env value without exposing it', () => {
  const result = verifyRuntimeEnvInjection({ scope: SECRET_SCOPES.LOCAL_ONLY, required_env_keys: ['TELEGRAM_BOT_TOKEN'], env: { TELEGRAM_BOT_TOKEN: ['12345678', ':', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'].join('') } });
  expect(result).toMatchObject({
    ok: true,
    reason: null,
    injection_allowed: true,
    production_allowed: false,
    display_allowed: false,
    persistence_allowed: false,
    log_values_allowed: false,
    materialized_env_keys: ['TELEGRAM_BOT_TOKEN'],
    materialized_env_preview: { TELEGRAM_BOT_TOKEN: '<present:redacted>' },
    next_action: 'inject_runtime_env_values_without_logging'
  });
  expect(JSON.stringify(result)).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890');
});

test('verifyRuntimeEnvInjection blocks production scope through secrets policy', () => {
  expect(verifyRuntimeEnvInjection({ target_env: 'production', scope: SECRET_SCOPES.PRODUCTION, required_env_keys: ['PRODUCTION_TOKEN'], env: { PRODUCTION_TOKEN: 'present' } })).toMatchObject({
    ok: false,
    reason: 'production_secret_injection_requires_human_approval',
    production_allowed: false,
    injection_allowed: false
  });
});
