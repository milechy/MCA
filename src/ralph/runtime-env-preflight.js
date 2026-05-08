const { SECRET_SCOPES, decideSecretInjection, isSecretReference, looksLikeSecretValue, redactSecretLike } = require('./secrets-policy');

const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,80}$/;

function normalizeEnvKey(value) {
  const key = String(value || '').trim();
  return ENV_KEY_PATTERN.test(key) ? key : null;
}

function envReference(key) {
  const normalized = normalizeEnvKey(key);
  return normalized ? `env:${normalized}` : null;
}

function normalizeEnvReferences({ references = [], required_env_keys = [] } = {}) {
  const explicitRefs = Array.isArray(references) ? references.map((ref) => String(ref || '').trim()).filter(Boolean) : [];
  const keyRefs = Array.isArray(required_env_keys) ? required_env_keys.map(envReference).filter(Boolean) : [];
  return Array.from(new Set([...explicitRefs, ...keyRefs])).slice(0, 50);
}

function referenceToEnvKey(reference) {
  const match = /^env:([A-Z][A-Z0-9_]{1,80})$/.exec(String(reference || '').trim());
  return match ? match[1] : null;
}

function makeBlocked(reason, details = {}) {
  return {
    ok: false,
    stage: 'runtime_env_injection_preflight',
    reason,
    target_env: details.target_env || 'local',
    scope: details.scope || SECRET_SCOPES.NONE,
    references: (details.references || []).map(redactSecretLike),
    required_env_keys: details.required_env_keys || [],
    missing_env_keys: details.missing_env_keys || [],
    invalid_reference_preview: details.invalid_reference_preview || null,
    injection_allowed: false,
    production_allowed: false,
    display_allowed: false,
    persistence_allowed: false,
    log_values_allowed: false,
    materialized_env_keys: [],
    materialized_env_preview: {},
    next_action: 'fix_runtime_env_injection_request'
  };
}

function verifyRuntimeEnvInjection({
  target_env = 'local',
  scope = SECRET_SCOPES.NONE,
  action = 'runtime_env_injection',
  references = [],
  required_env_keys = [],
  env = process.env,
  approval_id = null
} = {}) {
  const normalizedReferences = normalizeEnvReferences({ references, required_env_keys });
  const normalizedRequiredKeys = (Array.isArray(required_env_keys) ? required_env_keys : []).map(normalizeEnvKey).filter(Boolean);

  const literalSecret = normalizedReferences.find((ref) => looksLikeSecretValue(ref));
  if (literalSecret) {
    return makeBlocked('literal_secret_value_not_allowed', { target_env, scope, references: normalizedReferences, required_env_keys: normalizedRequiredKeys, invalid_reference_preview: '<redacted>' });
  }

  const invalidReference = normalizedReferences.find((ref) => !isSecretReference(ref));
  if (invalidReference) {
    return makeBlocked('secret_reference_invalid', { target_env, scope, references: normalizedReferences, required_env_keys: normalizedRequiredKeys, invalid_reference_preview: redactSecretLike(invalidReference) });
  }

  const secretDecision = decideSecretInjection({ target_env, scope, action, references: normalizedReferences, approval_id });
  if (!secretDecision.ok) {
    return makeBlocked(secretDecision.reason, { target_env, scope, references: normalizedReferences, required_env_keys: normalizedRequiredKeys, invalid_reference_preview: secretDecision.invalid_reference_preview });
  }

  const envKeys = normalizedReferences.map(referenceToEnvKey).filter(Boolean);
  const missing = envKeys.filter((key) => !Object.prototype.hasOwnProperty.call(env, key) || env[key] === '');
  if (missing.length > 0) {
    return makeBlocked('required_env_reference_missing', { target_env, scope, references: normalizedReferences, required_env_keys: normalizedRequiredKeys, missing_env_keys: missing });
  }

  const materialized = Object.fromEntries(envKeys.map((key) => [key, env[key] ? '<present:redacted>' : '<missing>']));
  return {
    ok: true,
    stage: 'runtime_env_injection_preflight',
    reason: null,
    target_env,
    scope,
    action,
    references: normalizedReferences.map(redactSecretLike),
    required_env_keys: normalizedRequiredKeys,
    missing_env_keys: [],
    injection_allowed: secretDecision.injection_allowed === true,
    production_allowed: false,
    display_allowed: false,
    persistence_allowed: false,
    log_values_allowed: false,
    materialized_env_keys: envKeys,
    materialized_env_preview: materialized,
    secret_policy: secretDecision,
    next_action: secretDecision.injection_allowed === true ? 'inject_runtime_env_values_without_logging' : 'continue_without_secret_injection'
  };
}

module.exports = {
  ENV_KEY_PATTERN,
  normalizeEnvKey,
  envReference,
  normalizeEnvReferences,
  referenceToEnvKey,
  verifyRuntimeEnvInjection
};
