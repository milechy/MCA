const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const VOLATILE_PLAN_FIELDS = new Set([
  'created_at',
  'updated_at',
  'expires_at',
  'approved_at',
  'generated_by',
  'model_response_id',
  'trace_id',
  'token_usage',
  'latency_ms'
]);

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .filter((key) => !VOLATILE_PLAN_FIELDS.has(key))
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }

  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function calculatePlanHash(plan) {
  return sha256(canonicalJson(plan));
}

function calculateDiffHash(cwd = process.cwd()) {
  const diff = execFileSync('git', ['diff', '--binary', '--full-index'], {
    cwd,
    encoding: 'utf8'
  });
  return sha256(diff);
}

module.exports = {
  VOLATILE_PLAN_FIELDS,
  sha256,
  canonicalize,
  canonicalJson,
  calculatePlanHash,
  calculateDiffHash
};
