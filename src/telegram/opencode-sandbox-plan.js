const path = require('node:path');
const {
  DEFAULT_ALLOWED_PATHS,
  DEFAULT_FORBIDDEN_PATHS,
  classifyIntent
} = require('./opencode-dry-run');

function oneLine(value, maxLength = 180) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function sanitizeApprovalId(value) {
  const approvalId = oneLine(value, 120);
  if (!/^APR-[A-Z0-9][A-Z0-9_-]*$/.test(approvalId)) return null;
  return approvalId;
}

function makeSandboxRoot(approvalId) {
  const safeApprovalId = sanitizeApprovalId(approvalId);
  if (!safeApprovalId) return null;
  return `.ralph/tmp/opencode-sandbox/${safeApprovalId}`;
}

function isAllowedSandboxRoot(sandboxRoot) {
  const normalized = String(sandboxRoot || '').replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!normalized.startsWith('.ralph/tmp/opencode-sandbox/')) return false;
  if (normalized.includes('/../') || normalized.endsWith('/..') || normalized.includes('/./')) return false;
  if (path.isAbsolute(normalized)) return false;
  return /^\.ralph\/tmp\/opencode-sandbox\/APR-[A-Z0-9][A-Z0-9_-]*$/.test(normalized);
}

function makeSandboxBranch(approvalId) {
  const safeApprovalId = sanitizeApprovalId(approvalId);
  if (!safeApprovalId) return null;
  return `opencode-sandbox/${safeApprovalId.toLowerCase()}`;
}

function makeOpenCodeSandboxPlan({ intent, approval_id } = {}, options = {}) {
  const safeApprovalId = sanitizeApprovalId(approval_id);
  const classification = classifyIntent(intent);
  const allowedPaths = options.allowed_paths || DEFAULT_ALLOWED_PATHS;
  const forbiddenPaths = options.forbidden_paths || DEFAULT_FORBIDDEN_PATHS;

  if (!safeApprovalId) {
    return {
      ok: false,
      stage: 'opencode_sandbox_plan_validation',
      reason: 'approval_id_invalid',
      approval_id: null,
      intent_summary: classification.summary || oneLine(intent),
      sandbox_root: null,
      sandbox_branch: null,
      risk: { category: 'blocked', label: 'SANDBOX_APPROVAL_ID_REQUIRED', requires_approval: true },
      requires_approval: true,
      allowed_paths: [...allowedPaths],
      forbidden_paths: [...forbiddenPaths],
      expected_tests: [],
      execution_connected: false,
      opencode_execution_enabled: false,
      commands_executed: [],
      files_modified: [],
      commit_created: false,
      push_performed: false,
      deploy_performed: false,
      migration_performed: false,
      next_action: 'create_fresh_approval_before_sandbox'
    };
  }

  const sandboxRoot = makeSandboxRoot(safeApprovalId);
  if (!classification.ok) {
    return {
      ok: false,
      stage: 'opencode_sandbox_intent_classification',
      reason: classification.reason,
      approval_id: safeApprovalId,
      intent_summary: classification.summary,
      sandbox_root: sandboxRoot,
      sandbox_branch: makeSandboxBranch(safeApprovalId),
      risk: { category: 'blocked', label: 'BLOCKED_BEFORE_SANDBOX', requires_approval: true },
      requires_approval: true,
      allowed_paths: [...allowedPaths],
      forbidden_paths: [...forbiddenPaths],
      expected_tests: [],
      execution_connected: false,
      opencode_execution_enabled: false,
      commands_executed: [],
      files_modified: [],
      commit_created: false,
      push_performed: false,
      deploy_performed: false,
      migration_performed: false,
      next_action: 'revise_intent_or_use_manual_review'
    };
  }

  return {
    ok: true,
    stage: 'opencode_sandbox_plan',
    reason: null,
    approval_id: safeApprovalId,
    intent_summary: classification.summary,
    sandbox_root: sandboxRoot,
    sandbox_branch: makeSandboxBranch(safeApprovalId),
    risk: {
      category: 'sandbox_planning_only',
      label: 'SANDBOX_METADATA_ONLY_APPROVAL_REQUIRED_BEFORE_EXECUTION',
      requires_approval: true
    },
    requires_approval: true,
    allowed_paths: [...allowedPaths],
    forbidden_paths: [...forbiddenPaths],
    expected_tests: ['npm run test:telegram', './scripts/gates/run-all.sh'],
    execution_connected: false,
    opencode_execution_enabled: false,
    commands_executed: [],
    files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'review_sandbox_plan_then_request_phase12_execution_approval'
  };
}

function summarizeOpenCodeSandboxPlan(plan) {
  return {
    ok: plan.ok === true,
    stage: plan.stage || null,
    reason: plan.reason || null,
    approval_id: plan.approval_id || null,
    intent_summary: oneLine(plan.intent_summary, 180),
    sandbox_root: plan.sandbox_root || null,
    sandbox_branch: plan.sandbox_branch || null,
    risk: plan.risk || null,
    requires_approval: plan.requires_approval === true,
    allowed_paths: Array.isArray(plan.allowed_paths) ? plan.allowed_paths : [],
    forbidden_paths: Array.isArray(plan.forbidden_paths) ? plan.forbidden_paths : [],
    expected_tests: Array.isArray(plan.expected_tests) ? plan.expected_tests.slice(0, 8) : [],
    execution_connected: false,
    opencode_execution_enabled: false,
    commands_executed: [],
    files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: plan.next_action || null
  };
}

module.exports = {
  sanitizeApprovalId,
  makeSandboxRoot,
  isAllowedSandboxRoot,
  makeSandboxBranch,
  makeOpenCodeSandboxPlan,
  summarizeOpenCodeSandboxPlan
};
