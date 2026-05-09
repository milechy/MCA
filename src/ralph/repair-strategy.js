const FAILURE_TYPES = Object.freeze({
  SECRET_SCAN: 'secret_scan',
  SECURITY_POLICY: 'security_policy',
  TYPECHECK: 'typecheck',
  BUILD: 'build',
  MIGRATION: 'migration',
  E2E: 'e2e',
  TEST: 'test_failure',
  TIMEOUT: 'timeout',
  UNKNOWN: 'unknown'
});

const FAILURE_TYPE_ATTEMPT_CAPS = Object.freeze({
  [FAILURE_TYPES.SECRET_SCAN]: 0,
  [FAILURE_TYPES.SECURITY_POLICY]: 0,
  [FAILURE_TYPES.MIGRATION]: 0,
  [FAILURE_TYPES.TIMEOUT]: 1,
  [FAILURE_TYPES.TYPECHECK]: 2,
  [FAILURE_TYPES.BUILD]: 2,
  [FAILURE_TYPES.E2E]: 2,
  [FAILURE_TYPES.TEST]: 3,
  [FAILURE_TYPES.UNKNOWN]: null
});

function oneLine(value, maxLength = 600) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function redactText(value, maxLength = 1000) {
  return oneLine(value, maxLength)
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]')
    .replace(/(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s`'\"]+/gi, '$1=[REDACTED]');
}

function normalizePath(value) {
  const item = String(value || '').replace(/\\/g, '/').trim();
  if (!item || item.startsWith('/') || item.includes('..')) return null;
  return item;
}

function extractTargetFiles(failure = {}, story = {}) {
  const fromFailure = [
    ...(Array.isArray(failure.repository_files_modified) ? failure.repository_files_modified : []),
    ...(Array.isArray(failure.files_modified) ? failure.files_modified : []),
    ...(Array.isArray(failure.requested_paths) ? failure.requested_paths : [])
  ];
  const fromStory = [
    ...(Array.isArray(story.requested_paths) ? story.requested_paths : []),
    ...(Array.isArray(story.last_ultraplan?.planned_files) ? story.last_ultraplan.planned_files : [])
  ];
  return Array.from(new Set([...fromFailure, ...fromStory].map(normalizePath).filter(Boolean))).slice(0, 25);
}

function joinedFailureText(failure = {}) {
  return [
    failure.failed_gate,
    failure.id,
    failure.stage,
    failure.reason,
    failure.command,
    failure.stdout_preview,
    failure.stderr_preview,
    ...(Array.isArray(failure.commands_executed) ? failure.commands_executed : [])
  ].filter(Boolean).join(' ');
}

function classifyFailure(failure = {}) {
  const text = joinedFailureText(failure).toLowerCase();
  const gate = String(failure.failed_gate || failure.id || '').toLowerCase();
  const reason = String(failure.reason || '').toLowerCase();
  if (reason.includes('timeout') || text.includes('timed out') || text.includes('timeout')) return FAILURE_TYPES.TIMEOUT;
  if (gate.includes('secret') || text.includes('secret-scan') || text.includes('potential secret')) return FAILURE_TYPES.SECRET_SCAN;
  if (text.includes('rls') || text.includes('security policy') || text.includes('forbidden') || text.includes('policy violation')) return FAILURE_TYPES.SECURITY_POLICY;
  if (gate.includes('type') || text.includes('typecheck') || text.includes('tsc') || text.includes('typescript')) return FAILURE_TYPES.TYPECHECK;
  if (gate.includes('build') || text.includes('npm run build') || text.includes('build failed')) return FAILURE_TYPES.BUILD;
  if (gate.includes('supabase') || gate.includes('migration') || text.includes('migration') || text.includes('supabase db')) return FAILURE_TYPES.MIGRATION;
  if (gate.includes('playwright') || gate.includes('e2e') || text.includes('playwright') || text.includes('browser')) return FAILURE_TYPES.E2E;
  if (gate.includes('test') || text.includes('test failed') || text.includes('expect(') || text.includes('assertion')) return FAILURE_TYPES.TEST;
  return FAILURE_TYPES.UNKNOWN;
}

function attemptCapForFailureType(failure_type, configuredCap = 3) {
  const cap = FAILURE_TYPE_ATTEMPT_CAPS[failure_type];
  return cap === null || cap === undefined ? configuredCap : cap;
}

function shouldEscalateImmediately(failure_type) {
  return [FAILURE_TYPES.SECRET_SCAN, FAILURE_TYPES.SECURITY_POLICY, FAILURE_TYPES.MIGRATION].includes(failure_type);
}

function summarizeFailureForRepair(failure = {}) {
  return {
    failed_gate: failure.failed_gate || failure.id || null,
    stage: failure.stage || null,
    reason: redactText(failure.reason || '', 160) || null,
    exit_code: Number.isInteger(failure.exit_code) ? failure.exit_code : null,
    stdout_preview: redactText(failure.stdout_preview || failure.stdout || '', 500),
    stderr_preview: redactText(failure.stderr_preview || failure.stderr || '', 500),
    commands_executed: Array.isArray(failure.commands_executed) ? failure.commands_executed.map((item) => redactText(item, 180)).slice(0, 10) : []
  };
}

function buildRepairInstruction({ story = {}, failure = {}, failure_type, target_files = [] } = {}) {
  const summary = summarizeFailureForRepair(failure);
  return [
    `Repair failure type: ${failure_type || FAILURE_TYPES.UNKNOWN}`,
    `Story: ${redactText(story.story_id || 'unknown', 120)} ${redactText(story.title || '', 160)}`.trim(),
    target_files.length > 0 ? `Target files: ${target_files.slice(0, 12).join(', ')}` : 'Target files: infer from bounded failure and story context only',
    `Failed gate: ${summary.failed_gate || 'unknown'}`,
    `Reason: ${summary.reason || 'unknown'}`,
    summary.stdout_preview ? `Stdout preview: ${summary.stdout_preview}` : null,
    summary.stderr_preview ? `Stderr preview: ${summary.stderr_preview}` : null,
    'Do not expose raw logs or secrets. Do not apply, commit, push, create PR, deploy, run production migration, disable RLS, or use unrestricted shell. Produce a bounded candidate patch only.'
  ].filter(Boolean).join('\n');
}

function buildRepairDecision({ story = {}, failure = {}, attempts = 0, max_attempts = null, now = new Date() } = {}) {
  const failure_type = classifyFailure(failure);
  const configuredCap = Number.isInteger(max_attempts) && max_attempts >= 0 ? max_attempts : Number.isInteger(story.max_attempts) ? story.max_attempts : 3;
  const typeCap = attemptCapForFailureType(failure_type, configuredCap);
  const effective_cap = Math.min(typeCap, configuredCap);
  const target_files = extractTargetFiles(failure, story);
  const immediate = shouldEscalateImmediately(failure_type);
  const exhausted = attempts >= effective_cap;
  const escalation_required = immediate || exhausted;
  const repair_instruction = buildRepairInstruction({ story, failure, failure_type, target_files });
  const repair_event = {
    at: now.toISOString(),
    failure_type,
    failed_gate: failure.failed_gate || failure.id || null,
    attempts,
    effective_cap,
    escalation_required,
    target_files,
    reason: escalation_required ? immediate ? 'immediate_escalation_required' : 'repair_attempt_cap_exhausted' : 'repair_candidate_required'
  };
  return {
    ok: true,
    stage: 'repair_strategy',
    failure_type,
    attempts,
    effective_cap,
    escalation_required,
    immediate_escalation: immediate,
    target_files,
    repair_instruction,
    repair_event,
    failure_summary: summarizeFailureForRepair(failure),
    execution_connected: false,
    commands_executed: [],
    repository_files_modified: [],
    next_action: escalation_required ? 'human_escalation_required' : 'dispatch_opencode_fix_candidate_patch_via_nemoclaw'
  };
}

function appendRepairHistory(story = {}, repair_event = {}) {
  const current = Array.isArray(story.repair_history) ? story.repair_history : [];
  return [...current, repair_event].slice(-25);
}

module.exports = {
  FAILURE_TYPES,
  FAILURE_TYPE_ATTEMPT_CAPS,
  redactText,
  extractTargetFiles,
  classifyFailure,
  attemptCapForFailureType,
  shouldEscalateImmediately,
  summarizeFailureForRepair,
  buildRepairInstruction,
  buildRepairDecision,
  appendRepairHistory
};
