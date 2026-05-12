const fs = require('node:fs');
const path = require('node:path');

const LIVE_VALIDATION_REPORT_VERSION = 'live_validation_report_v0_1';
const SAFE_LEVELS = new Set([0, 1, 2, 3, 4, 5]);
const PROVIDER_BLOCKERS = new Set(['provider_rate_limited', 'candidate_patch_missing', 'agent_output_contract_violation']);
const RUNTIME_BLOCKERS = new Set(['nemoclaw_runtime_timeout', 'external_agent_timeout', 'gateway_runtime_timeout']);
const TRANSIENT_BLOCKERS = new Set([...PROVIDER_BLOCKERS, ...RUNTIME_BLOCKERS]);

function safeLevel(value) {
  const level = Number(value);
  return SAFE_LEVELS.has(level) ? level : null;
}

function safeRelativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!normalized || normalized.startsWith('/') || normalized.includes('..') || /\0/.test(normalized)) return null;
  return normalized;
}

function oneLine(value, maxLength = 500) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_SECRET]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[REDACTED_SECRET]');
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function boundedSmokeResult(result = {}) {
  const run = result.run || {};
  return {
    ok: result.ok === true,
    skipped: result.skipped === true,
    blocked: result.blocked === true || TRANSIENT_BLOCKERS.has(result.reason || run.reason),
    stage: result.stage || null,
    reason: result.reason || run.reason || null,
    gateway_type: result.gateway_type || null,
    gateway_name: result.gateway_name || null,
    opencode_runtime_mode: result.opencode_runtime_mode || null,
    mediator: result.mediator || null,
    job_id: result.job_id || null,
    approval_id: result.approval_id || null,
    sandbox_root: result.sandbox_root || null,
    candidate_patch_path: result.candidate_patch_path || null,
    runtime_installed: result.runtime_installed === true,
    working_tree_clean_before: result.working_tree_clean_before === true,
    working_tree_clean_after: result.working_tree_clean_after === true,
    execution_connected: result.execution_connected === true,
    real_gateway_process_started: result.real_gateway_process_started === true,
    opencode_execution_started: run.opencode_execution_started === true,
    cleanup: result.cleanup || null,
    apply_allowed: result.apply_allowed === true,
    commit_created: result.commit_created === true,
    push_performed: result.push_performed === true,
    pr_created: result.pr_created === true,
    merge_performed: result.merge_performed === true,
    deploy_performed: result.deploy_performed === true,
    migration_performed: result.migration_performed === true,
    next_action: result.next_action || null,
    command_preview: oneLine(run.command_preview || ''),
    stdout_preview: oneLine(run.stdout_preview || ''),
    stderr_preview: oneLine(run.stderr_preview || ''),
    commands_executed: Array.isArray(run.commands_executed) ? run.commands_executed.map((item) => oneLine(item, 180)).slice(0, 10) : []
  };
}

function blockerKind(reason) {
  if (PROVIDER_BLOCKERS.has(reason)) return 'provider';
  if (RUNTIME_BLOCKERS.has(reason)) return 'runtime';
  return null;
}

function summarizeDecision(level, smoke) {
  if (level === 0 && smoke.ok) return 'level_0_passed';
  if (level === 1 && smoke.ok && smoke.candidate_patch_path && smoke.working_tree_clean_after) return 'level_1_passed_continue_to_level_2';
  if (level === 1 && PROVIDER_BLOCKERS.has(smoke.reason)) return 'hold_before_level_2_provider_blocked';
  if (level === 1 && RUNTIME_BLOCKERS.has(smoke.reason)) return 'hold_before_level_2_runtime_blocked';
  if (smoke.ok) return `level_${level}_passed`;
  return `level_${level}_failed_review_required`;
}

function createLiveValidationReport({ level, smoke_result, now = new Date() } = {}) {
  const safe = safeLevel(level);
  if (safe === null) {
    return { ok: false, stage: 'ralph_live_validation_report', version: LIVE_VALIDATION_REPORT_VERSION, reason: 'level_not_allowed', next_action: 'choose_level_0_to_5' };
  }
  const smoke = boundedSmokeResult(smoke_result || {});
  const kind = blockerKind(smoke.reason);
  const transientBlocked = Boolean(kind || smoke.blocked === true);
  const unsafeSideEffects = Boolean(
    smoke.apply_allowed ||
    smoke.commit_created ||
    smoke.push_performed ||
    smoke.pr_created ||
    smoke.merge_performed ||
    smoke.deploy_performed ||
    smoke.migration_performed
  );
  const report = {
    ok: true,
    stage: 'ralph_live_validation_report',
    version: LIVE_VALIDATION_REPORT_VERSION,
    level: safe,
    generated_at: now.toISOString(),
    provider_blocked: kind === 'provider' || smoke.blocked === true && PROVIDER_BLOCKERS.has(smoke.reason),
    provider_blocker_reason: kind === 'provider' ? smoke.reason : null,
    runtime_blocked: kind === 'runtime',
    runtime_blocker_reason: kind === 'runtime' ? smoke.reason : null,
    transient_blocked: transientBlocked,
    transient_blocker_kind: kind,
    candidate_patch_available: Boolean(smoke.candidate_patch_path),
    safe_side_effects: !unsafeSideEffects,
    working_tree_clean_after: smoke.working_tree_clean_after === true,
    decision: summarizeDecision(safe, smoke),
    smoke,
    next_action: kind === 'provider'
      ? 'retry_level_1_after_provider_recovers'
      : kind === 'runtime'
        ? 'retry_level_1_after_runtime_recovers'
        : smoke.ok ? 'continue_validation_ladder' : 'inspect_live_validation_failure'
  };
  return report;
}

function defaultReportPath({ level, now = new Date() } = {}) {
  const safe = safeLevel(level);
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return `.ralph/live-validation/level-${safe}-${stamp}.json`;
}

function writeLiveValidationReport({ rootDir = process.cwd(), report, output_path } = {}) {
  const rel = safeRelativePath(output_path);
  if (!rel || !rel.startsWith('.ralph/live-validation/')) {
    return { ok: false, stage: 'ralph_live_validation_report_write', reason: 'output_path_not_allowed', output_path: output_path || null, next_action: 'use_ralph_live_validation_output_path' };
  }
  const abs = path.resolve(rootDir, rel);
  const prefix = path.resolve(rootDir, '.ralph', 'live-validation');
  if (!abs.startsWith(prefix)) {
    return { ok: false, stage: 'ralph_live_validation_report_write', reason: 'output_path_not_allowed', output_path: rel, next_action: 'use_ralph_live_validation_output_path' };
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { ok: true, stage: 'ralph_live_validation_report_write', reason: null, output_path: rel, bytes: Buffer.byteLength(JSON.stringify(report, null, 2) + '\n', 'utf8'), next_action: 'review_live_validation_report' };
}

function recordLiveValidationResult({ rootDir = process.cwd(), level, smoke_result, output_path, now = new Date() } = {}) {
  const report = createLiveValidationReport({ level, smoke_result, now });
  if (!report.ok) return report;
  const out = output_path || defaultReportPath({ level, now });
  const written = writeLiveValidationReport({ rootDir, report, output_path: out });
  return { ...report, output: written, next_action: report.next_action };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
  LIVE_VALIDATION_REPORT_VERSION,
  PROVIDER_BLOCKERS,
  RUNTIME_BLOCKERS,
  TRANSIENT_BLOCKERS,
  safeLevel,
  safeRelativePath,
  oneLine,
  boundedSmokeResult,
  blockerKind,
  createLiveValidationReport,
  defaultReportPath,
  writeLiveValidationReport,
  recordLiveValidationResult,
  readJson
};
