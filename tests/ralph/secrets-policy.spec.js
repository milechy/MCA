const { test, expect } = require('@playwright/test');

const { SECRET_SCOPES, looksLikeSecretValue, isSecretReference, redactSecretLike, decideSecretInjection } = require('../../src/ralph/secrets-policy');

test('secret reference policy allows references but not values', () => {
  expect(isSecretReference('env:TELEGRAM_BOT_TOKEN')).toBe(true);
  expect(isSecretReference('vault:PROJECT:API_KEY')).toBe(true);
  expect(isSecretReference('plain-token')).toBe(false);
  expect(looksLikeSecretValue(['12345678', ':', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'].join(''))).toBe(true);
  expect(redactSecretLike(`token ${['ghp', '_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'].join('')}`)).toContain('<redacted>');
});

test('decideSecretInjection blocks literal or invalid secret material', () => {
  expect(decideSecretInjection({ target_env: 'local', scope: SECRET_SCOPES.LOCAL_ONLY, references: ['plain-token'] })).toMatchObject({
    ok: false,
    reason: 'secret_reference_invalid',
    injection_allowed: false,
    display_allowed: false,
    persistence_allowed: false,
    log_values_allowed: false
  });
  expect(decideSecretInjection({ target_env: 'local', scope: SECRET_SCOPES.LOCAL_ONLY, references: [['env:BAD', ['12345678', ':', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'].join('')].join('_')] }).ok).toBe(false);
});

test('decideSecretInjection blocks production secret injection', () => {
  expect(decideSecretInjection({ target_env: 'production', scope: SECRET_SCOPES.PRODUCTION, references: ['env:PRODUCTION_API_KEY'] })).toMatchObject({
    ok: false,
    reason: 'production_secret_injection_requires_human_approval',
    injection_allowed: false,
    production_allowed: false
  });
});

test('decideSecretInjection allows local reference-only runtime injection', () => {
  expect(decideSecretInjection({ target_env: 'local', scope: SECRET_SCOPES.LOCAL_ONLY, action: 'telegram_smoke', references: ['env:TELEGRAM_BOT_TOKEN'], approval_id: 'APR-1' })).toMatchObject({
    ok: true,
    reason: null,
    decision: 'allow_reference_only_injection',
    target_env: 'local',
    scope: SECRET_SCOPES.LOCAL_ONLY,
    action: 'telegram_smoke',
    references: ['env:<ref>'],
    approval_id: 'APR-1',
    injection_allowed: true,
    production_allowed: false,
    display_allowed: false,
    persistence_allowed: false,
    log_values_allowed: false
  });
});

test('decideSecretInjection defaults to no secret injection', () => {
  expect(decideSecretInjection({})).toMatchObject({
    ok: true,
    decision: 'no_secrets_injected',
    injection_allowed: false,
    display_allowed: false,
    persistence_allowed: false,
    log_values_allowed: false
  });
});
