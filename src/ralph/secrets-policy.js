const SECRET_REFERENCE_PATTERN = /^(env|vault|supabase|github|telegram):[A-Z0-9_:-]{3,120}$/;
const SECRET_VALUE_PATTERNS = Object.freeze([
  /\d{8,}:[A-Za-z0-9_-]{20,}/,
  /ghp_[A-Za-z0-9_]{20,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /[A-Za-z0-9+/]{40,}={0,2}/
]);

const SECRET_SCOPES = Object.freeze({
  NONE: 'none',
  READ_ONLY: 'read_only',
  LOCAL_ONLY: 'local_only',
  PRODUCTION: 'production'
});

function oneLine(value, maxLength = 160) {
  const normalized = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function looksLikeSecretValue(value) {
  const text = String(value || '');
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(text));
}

function isSecretReference(value) {
  return SECRET_REFERENCE_PATTERN.test(String(value || '').trim());
}

function redactSecretLike(value) {
  return String(value || '').replace(/(env|vault|supabase|github|telegram):[A-Z0-9_:-]{3,120}/g, '$1:<ref>').replace(/\S+/g, (part) => looksLikeSecretValue(part) ? '<redacted>' : part);
}

function normalizeSecretRequest(request = {}) {
  const references = Array.isArray(request.references) ? request.references : [];
  return {
    target_env: request.target_env || request.environment || 'local',
    scope: request.scope || SECRET_SCOPES.NONE,
    action: request.action || 'none',
    references: references.map((ref) => String(ref || '').trim()).filter(Boolean).slice(0, 25),
    reason: oneLine(request.reason || ''),
    approval_id: request.approval_id || null
  };
}

function decideSecretInjection(request = {}) {
  const normalized = normalizeSecretRequest(request);
  const literalSecret = normalized.references.find((ref) => looksLikeSecretValue(ref));
  if (literalSecret) {
    return blocked('literal_secret_value_not_allowed', normalized, { invalid_reference_preview: '<redacted>' });
  }
  const invalidReference = normalized.references.find((ref) => !isSecretReference(ref));
  if (invalidReference) {
    return blocked('secret_reference_invalid', normalized, { invalid_reference_preview: redactSecretLike(invalidReference) });
  }
  if (normalized.target_env === 'production') {
    return blocked('production_secret_injection_requires_human_approval', normalized);
  }
  if (![SECRET_SCOPES.NONE, SECRET_SCOPES.READ_ONLY, SECRET_SCOPES.LOCAL_ONLY].includes(normalized.scope)) {
    return blocked('secret_scope_not_allowed', normalized);
  }
  if (normalized.references.length === 0 || normalized.scope === SECRET_SCOPES.NONE) {
    return {
      ok: true,
      stage: 'secrets_injection_policy',
      reason: null,
      decision: 'no_secrets_injected',
      target_env: normalized.target_env,
      scope: normalized.scope,
      action: normalized.action,
      references: [],
      approval_id: normalized.approval_id,
      injection_allowed: false,
      production_allowed: false,
      display_allowed: false,
      persistence_allowed: false,
      log_values_allowed: false,
      next_action: 'continue_without_secret_injection'
    };
  }
  return {
    ok: true,
    stage: 'secrets_injection_policy',
    reason: null,
    decision: 'allow_reference_only_injection',
    target_env: normalized.target_env,
    scope: normalized.scope,
    action: normalized.action,
    references: normalized.references.map(redactSecretLike),
    approval_id: normalized.approval_id,
    injection_allowed: true,
    production_allowed: false,
    display_allowed: false,
    persistence_allowed: false,
    log_values_allowed: false,
    next_action: 'inject_secret_references_at_runtime_only'
  };
}

function blocked(reason, normalized, extra = {}) {
  return {
    ok: false,
    stage: 'secrets_injection_policy',
    reason,
    decision: 'block_secret_injection',
    target_env: normalized.target_env,
    scope: normalized.scope,
    action: normalized.action,
    references: normalized.references.map(redactSecretLike),
    approval_id: normalized.approval_id,
    injection_allowed: false,
    production_allowed: false,
    display_allowed: false,
    persistence_allowed: false,
    log_values_allowed: false,
    invalid_reference_preview: extra.invalid_reference_preview || null,
    next_action: 'request_human_review_or_remove_secret_request'
  };
}

module.exports = {
  SECRET_REFERENCE_PATTERN,
  SECRET_SCOPES,
  looksLikeSecretValue,
  isSecretReference,
  redactSecretLike,
  normalizeSecretRequest,
  decideSecretInjection
};
