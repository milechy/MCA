const DEFAULT_ALLOWED_PATHS = Object.freeze([
  'docs/**',
  'scripts/**',
  'tests/**',
  'lib/**',
  'src/**',
  'package.json'
]);

const DEFAULT_FORBIDDEN_PATHS = Object.freeze([
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '.ralph/logs/**',
  '.ralph/approval-log.jsonl',
  'node_modules/**',
  '.git/**'
]);

const BLOCKED_INTENT_PATTERNS = Object.freeze([
  { pattern: /\bdeploy\b|production deploy/i, reason: 'production_deploy_requested' },
  { pattern: /\bmigration\b|migrate database|db migrate/i, reason: 'migration_requested' },
  { pattern: /secret|credential|token|api key|password/i, reason: 'secret_handling_requested' },
  { pattern: /remote shell|ssh|scp|rsync/i, reason: 'remote_shell_requested' },
  { pattern: /npm publish|package publish|publish package/i, reason: 'package_publish_requested' },
  { pattern: /billing|payment|invoice/i, reason: 'billing_or_payment_requested' }
]);

function oneLine(value, maxLength = 180) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function classifyIntent(intent) {
  const summary = oneLine(intent, 180);
  if (!summary) {
    return { ok: false, reason: 'intent_required', summary };
  }

  const blocked = BLOCKED_INTENT_PATTERNS.find(({ pattern }) => pattern.test(summary));
  if (blocked) {
    return { ok: false, reason: blocked.reason, summary };
  }

  return { ok: true, reason: null, summary };
}

function makeOpenCodeDryRunPlan(intent, options = {}) {
  const classification = classifyIntent(intent);
  const allowedPaths = options.allowed_paths || DEFAULT_ALLOWED_PATHS;
  const forbiddenPaths = options.forbidden_paths || DEFAULT_FORBIDDEN_PATHS;

  if (!classification.ok) {
    return {
      ok: false,
      stage: 'opencode_dry_run_intent_classification',
      reason: classification.reason,
      intent_summary: classification.summary,
      risk: {
        category: 'blocked',
        label: 'BLOCKED_BEFORE_OPENCODE',
        requires_approval: true
      },
      requires_approval: true,
      allowed_paths: [...allowedPaths],
      forbidden_paths: [...forbiddenPaths],
      proposed_steps: [],
      expected_tests: [],
      diff_preview: {
        available: false,
        reason: 'blocked_intent'
      },
      execution_connected: false,
      commands_executed: [],
      files_modified: [],
      next_action: 'revise_intent_or_use_manual_review'
    };
  }

  return {
    ok: true,
    stage: 'opencode_dry_run_plan',
    reason: null,
    intent_summary: classification.summary,
    risk: {
      category: 'planning_only',
      label: 'READ_ONLY_PLANNING_APPROVAL_REQUIRED_BEFORE_APPLY',
      requires_approval: true
    },
    requires_approval: true,
    allowed_paths: [...allowedPaths],
    forbidden_paths: [...forbiddenPaths],
    proposed_steps: [
      'clarify intent and target files',
      'prepare OpenCode plan without execution',
      'summarize expected diff shape',
      'run risk evaluation before any future apply',
      'require explicit approval before Phase 12 sandbox execution'
    ],
    expected_tests: [
      'npm run test:telegram',
      './scripts/gates/run-all.sh'
    ],
    diff_preview: {
      available: false,
      reason: 'phase11_metadata_only'
    },
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    next_action: 'review_plan_then_replan_for_phase12_sandbox'
  };
}

function summarizeOpenCodeDryRunPlan(plan) {
  return {
    ok: plan.ok === true,
    stage: plan.stage || null,
    reason: plan.reason || null,
    intent_summary: oneLine(plan.intent_summary, 180),
    risk: plan.risk || null,
    requires_approval: plan.requires_approval === true,
    allowed_paths: Array.isArray(plan.allowed_paths) ? plan.allowed_paths : [],
    forbidden_paths: Array.isArray(plan.forbidden_paths) ? plan.forbidden_paths : [],
    proposed_steps: Array.isArray(plan.proposed_steps) ? plan.proposed_steps.slice(0, 8) : [],
    expected_tests: Array.isArray(plan.expected_tests) ? plan.expected_tests.slice(0, 8) : [],
    diff_preview: plan.diff_preview || { available: false, reason: 'missing' },
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    next_action: plan.next_action || null
  };
}

module.exports = {
  DEFAULT_ALLOWED_PATHS,
  DEFAULT_FORBIDDEN_PATHS,
  classifyIntent,
  makeOpenCodeDryRunPlan,
  summarizeOpenCodeDryRunPlan
};
