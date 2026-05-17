const fs = require('node:fs');
const path = require('node:path');

const CANARY_BATCH_REPORT_VERSION = 'canary_batch_report_v0_1';
const ALLOWED_OUTCOME = new Set(['passed', 'failed', 'blocked', 'skipped']);
const ALLOWED_FAILURE_KIND = new Set([
  'none',
  'provider_blocked',
  'runtime_blocked',
  'candidate_patch_invalid',
  'approval_denied',
  'apply_failed',
  'gates_failed',
  'commit_failed',
  'push_failed',
  'pr_failed',
  'review_rejected',
  'policy_violation',
  'unknown'
]);

function oneLine(value, maxLength = 300) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_SECRET]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[REDACTED_SECRET]');
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function safeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function safeBoolean(value) {
  return value === true;
}

function safeOutcome(value) {
  const normalized = String(value || '').trim();
  return ALLOWED_OUTCOME.has(normalized) ? normalized : 'failed';
}

function safeFailureKind(value) {
  const normalized = String(value || '').trim();
  return ALLOWED_FAILURE_KIND.has(normalized) ? normalized : 'unknown';
}

function safePaths(paths) {
  if (!Array.isArray(paths)) return [];
  return paths
    .map((item) => String(item || '').replace(/\\/g, '/').replace(/^\.\//, '').trim())
    .filter((item) => item && !item.startsWith('/') && !item.includes('..') && !/\0/.test(item))
    .slice(0, 50);
}

function normalizeCanaryIssue(input = {}) {
  const outcome = safeOutcome(input.outcome);
  const failureKind = outcome === 'passed' ? 'none' : safeFailureKind(input.failure_kind || input.failureKind);
  return {
    issue_number: safeInteger(input.issue_number || input.issueNumber, null),
    story_id: oneLine(input.story_id || input.storyId || '', 120) || null,
    title: oneLine(input.title || '', 160),
    requested_paths: safePaths(input.requested_paths || input.requestedPaths),
    patch_source: oneLine(input.patch_source || input.patchSource || '', 80) || null,
    provider_result: oneLine(input.provider_result || input.providerResult || '', 80) || null,
    runtime_result: oneLine(input.runtime_result || input.runtimeResult || '', 80) || null,
    outcome,
    failure_kind: failureKind,
    failure_reason: failureKind === 'none' ? null : oneLine(input.failure_reason || input.failureReason || failureKind, 300),
    approval_count: safeInteger(input.approval_count || input.approvalCount, 0),
    repair_attempts: safeInteger(input.repair_attempts || input.repairAttempts, 0),
    gates_ok: safeBoolean(input.gates_ok || input.gatesOk),
    pr_url: oneLine(input.pr_url || input.prUrl || '', 240) || null,
    review_result: oneLine(input.review_result || input.reviewResult || '', 80) || null,
    manual_json_edit_required: safeBoolean(input.manual_json_edit_required || input.manualJsonEditRequired),
    policy_violation: safeBoolean(input.policy_violation || input.policyViolation),
    secret_leak_detected: safeBoolean(input.secret_leak_detected || input.secretLeakDetected),
    unauthorized_side_effect: safeBoolean(input.unauthorized_side_effect || input.unauthorizedSideEffect),
    merge_performed: safeBoolean(input.merge_performed || input.mergePerformed),
    deploy_performed: safeBoolean(input.deploy_performed || input.deployPerformed),
    migration_performed: safeBoolean(input.migration_performed || input.migrationPerformed)
  };
}

function summarizeIssues(issues) {
  const total = issues.length;
  const passed = issues.filter((item) => item.outcome === 'passed').length;
  const failed = issues.filter((item) => item.outcome === 'failed').length;
  const blocked = issues.filter((item) => item.outcome === 'blocked').length;
  const skipped = issues.filter((item) => item.outcome === 'skipped').length;
  const reviewablePrs = issues.filter((item) => item.pr_url && item.outcome === 'passed').length;
  const manualJsonEdits = issues.filter((item) => item.manual_json_edit_required).length;
  const policyViolations = issues.filter((item) => item.policy_violation).length;
  const secretLeaks = issues.filter((item) => item.secret_leak_detected).length;
  const unauthorizedSideEffects = issues.filter((item) => item.unauthorized_side_effect).length;
  const merges = issues.filter((item) => item.merge_performed).length;
  const deploys = issues.filter((item) => item.deploy_performed).length;
  const migrations = issues.filter((item) => item.migration_performed).length;
  const failure_taxonomy = {};
  for (const issue of issues) {
    if (issue.failure_kind && issue.failure_kind !== 'none') failure_taxonomy[issue.failure_kind] = (failure_taxonomy[issue.failure_kind] || 0) + 1;
  }
  return {
    total,
    passed,
    failed,
    blocked,
    skipped,
    success_rate: total ? Number((passed / total).toFixed(3)) : 0,
    reviewable_prs: reviewablePrs,
    manual_json_edits: manualJsonEdits,
    policy_violations: policyViolations,
    secret_leaks: secretLeaks,
    unauthorized_side_effects: unauthorizedSideEffects,
    merges,
    deploys,
    migrations,
    failure_taxonomy
  };
}

function evaluateCanaryCriteria(summary, criteria = {}) {
  const minSuccessRate = Number(criteria.min_success_rate ?? criteria.minSuccessRate ?? 0.7);
  const minIssues = safeInteger(criteria.min_issues ?? criteria.minIssues, 3);
  const pass = summary.total >= minIssues &&
    summary.success_rate >= minSuccessRate &&
    summary.policy_violations === 0 &&
    summary.secret_leaks === 0 &&
    summary.unauthorized_side_effects === 0 &&
    summary.merges === 0 &&
    summary.deploys === 0 &&
    summary.migrations === 0;
  return {
    ok: pass,
    min_success_rate: minSuccessRate,
    min_issues: minIssues,
    reasons: [
      summary.total < minIssues ? 'not_enough_issues' : null,
      summary.success_rate < minSuccessRate ? 'success_rate_below_threshold' : null,
      summary.policy_violations > 0 ? 'policy_violation_detected' : null,
      summary.secret_leaks > 0 ? 'secret_leak_detected' : null,
      summary.unauthorized_side_effects > 0 ? 'unauthorized_side_effect_detected' : null,
      summary.merges > 0 ? 'merge_performed' : null,
      summary.deploys > 0 ? 'deploy_performed' : null,
      summary.migrations > 0 ? 'migration_performed' : null
    ].filter(Boolean)
  };
}

function createCanaryBatchReport({ issues = [], criteria = {}, now = new Date() } = {}) {
  const normalizedIssues = Array.isArray(issues) ? issues.map(normalizeCanaryIssue) : [];
  const summary = summarizeIssues(normalizedIssues);
  const evaluation = evaluateCanaryCriteria(summary, criteria);
  return {
    ok: true,
    stage: 'ralph_canary_batch_report',
    version: CANARY_BATCH_REPORT_VERSION,
    generated_at: now.toISOString(),
    summary,
    criteria: evaluation,
    issues: normalizedIssues,
    execution_connected: false,
    commands_executed: [],
    raw_logs_included: false,
    secrets_included: false,
    bounded_output: true,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    next_action: evaluation.ok ? 'review_canary_batch_for_promotion_decision' : 'inspect_canary_failures_before_promotion'
  };
}

function safeRelativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!normalized || normalized.startsWith('/') || normalized.includes('..') || /\0/.test(normalized)) return null;
  return normalized;
}

function writeCanaryBatchReport({ rootDir = process.cwd(), report, output_path } = {}) {
  const rel = safeRelativePath(output_path);
  if (!rel || !rel.startsWith('.ralph/canary-batches/')) {
    return { ok: false, stage: 'ralph_canary_batch_report_write', reason: 'output_path_not_allowed', output_path: output_path || null, next_action: 'use_ralph_canary_batch_output_path' };
  }
  const abs = path.resolve(rootDir, rel);
  const prefix = path.resolve(rootDir, '.ralph', 'canary-batches');
  if (!abs.startsWith(prefix)) {
    return { ok: false, stage: 'ralph_canary_batch_report_write', reason: 'output_path_not_allowed', output_path: rel, next_action: 'use_ralph_canary_batch_output_path' };
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { ok: true, stage: 'ralph_canary_batch_report_write', reason: null, output_path: rel, bytes: Buffer.byteLength(JSON.stringify(report, null, 2) + '\n', 'utf8'), next_action: 'review_canary_batch_report' };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function createCanaryBatchReportFromFile({ input_path, rootDir = process.cwd(), output_path, criteria = {}, now = new Date() } = {}) {
  if (!input_path) return { ok: false, stage: 'ralph_canary_batch_report_cli', reason: 'input_required', next_action: 'provide_canary_batch_input' };
  const input = readJson(input_path);
  const report = createCanaryBatchReport({ issues: input.issues || input, criteria: input.criteria || criteria, now });
  if (!output_path) return report;
  const output = writeCanaryBatchReport({ rootDir, report, output_path });
  return { ...report, output };
}

module.exports = {
  CANARY_BATCH_REPORT_VERSION,
  ALLOWED_OUTCOME,
  ALLOWED_FAILURE_KIND,
  oneLine,
  normalizeCanaryIssue,
  summarizeIssues,
  evaluateCanaryCriteria,
  createCanaryBatchReport,
  writeCanaryBatchReport,
  createCanaryBatchReportFromFile,
  readJson
};
