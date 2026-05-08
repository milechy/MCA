const { spawnSync } = require('node:child_process');
const { appendExecutionLog } = require('./execution-log');

const DEFAULT_GATE_TIMEOUT_MS = 120000;

const GATE_SEQUENCE = Object.freeze([
  { id: 'pre-secret-scan', command: 'bash', args: ['scripts/gates/secret-scan.sh'], required: true, phase: 'pre' },
  { id: 'lint', command: 'npm', args: ['run', 'lint', '--if-present'], required: false, phase: 'quality' },
  { id: 'typecheck', command: 'npm', args: ['run', 'typecheck', '--if-present'], required: false, phase: 'quality' },
  { id: 'unit-tests', command: 'npm', args: ['run', 'test:unit', '--if-present'], required: false, phase: 'test' },
  { id: 'ralph-tests', command: 'bash', args: ['scripts/gates/ralph-tests.sh'], required: true, phase: 'test' },
  { id: 'telegram-tests', command: 'bash', args: ['scripts/gates/telegram-tests.sh'], required: true, phase: 'test' },
  { id: 'build', command: 'npm', args: ['run', 'build', '--if-present'], required: false, phase: 'build' },
  { id: 'supabase-local', command: 'bash', args: ['scripts/gates/supabase-local.sh'], required: true, phase: 'db' },
  { id: 'generated-types-check', command: 'npm', args: ['run', 'types:check', '--if-present'], required: false, phase: 'db' },
  { id: 'playwright-smoke', command: 'npm', args: ['run', 'test:e2e', '--if-present'], required: false, phase: 'e2e' },
  { id: 'playwright-regression', command: 'bash', args: ['scripts/gates/playwright-e2e.sh'], required: true, phase: 'e2e' },
  { id: 'post-secret-scan', command: 'bash', args: ['scripts/gates/secret-scan.sh'], required: true, phase: 'post' },
  { id: 'dependency-audit', command: 'npm', args: ['audit', '--audit-level=high'], required: false, phase: 'post' }
]);

const FORBIDDEN_GATE_TOKENS = Object.freeze([
  'deploy',
  'migration:apply',
  'supabase db push',
  'git push',
  'git commit',
  'git reset --hard',
  'force push',
  'merge'
]);

function oneLine(value, maxLength = 240) {
  const normalized = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function commandPreview(gate) {
  return [gate.command, ...(gate.args || [])].join(' ');
}

function validateGate(gate) {
  if (!gate || !gate.id || !gate.command || !Array.isArray(gate.args)) return { ok: false, reason: 'gate_shape_invalid' };
  const preview = commandPreview(gate);
  if (/[;&|`$<>]/.test(preview)) return { ok: false, reason: 'gate_shell_token_not_allowed' };
  if (FORBIDDEN_GATE_TOKENS.some((token) => preview.includes(token))) return { ok: false, reason: 'gate_forbidden_command' };
  return { ok: true, reason: null };
}

function describeGateSequence(gates = GATE_SEQUENCE) {
  return gates.map((gate, index) => ({
    order: index + 1,
    id: gate.id,
    phase: gate.phase,
    required: gate.required === true,
    command: commandPreview(gate),
    mutation_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    commit_allowed: false,
    push_allowed: false
  }));
}

function summarizeResult(result) {
  return {
    id: result.id,
    ok: result.ok === true,
    skipped: result.skipped === true,
    required: result.required === true,
    reason: result.reason || null,
    exit_code: Number.isInteger(result.exit_code) ? result.exit_code : null,
    duration_ms: Number.isInteger(result.duration_ms) ? result.duration_ms : null,
    stdout_preview: oneLine(result.stdout_preview || ''),
    stderr_preview: oneLine(result.stderr_preview || '')
  };
}

function runGate(gate, { rootDir = process.cwd(), env = process.env, timeout_ms = DEFAULT_GATE_TIMEOUT_MS, spawn = spawnSync } = {}) {
  const validation = validateGate(gate);
  const started = Date.now();
  if (!validation.ok) {
    return { id: gate?.id || null, ok: false, skipped: false, required: gate?.required === true, reason: validation.reason, exit_code: null, duration_ms: 0, stdout_preview: '', stderr_preview: '' };
  }

  const result = spawn(gate.command, gate.args, {
    cwd: rootDir,
    env: { PATH: env.PATH, HOME: env.HOME, CI: env.CI },
    encoding: 'utf8',
    timeout: timeout_ms,
    maxBuffer: 1024 * 128
  });
  const duration = Date.now() - started;
  const timedOut = result.error && result.error.code === 'ETIMEDOUT';
  const exitCode = typeof result.status === 'number' ? result.status : null;
  const optionalMissingScript = gate.required !== true && exitCode === 0;

  return {
    id: gate.id,
    ok: exitCode === 0 && !timedOut,
    skipped: optionalMissingScript && commandPreview(gate).includes('--if-present'),
    required: gate.required === true,
    reason: timedOut ? 'gate_timeout' : exitCode === 0 ? null : 'gate_failed',
    exit_code: exitCode,
    duration_ms: duration,
    stdout_preview: oneLine(result.stdout || ''),
    stderr_preview: oneLine(result.stderr || result.error?.message || '')
  };
}

function runGateSequence({ rootDir = process.cwd(), env = process.env, gates = GATE_SEQUENCE, timeout_ms = DEFAULT_GATE_TIMEOUT_MS, spawn = spawnSync } = {}) {
  const results = [];
  for (const gate of gates) {
    const result = runGate(gate, { rootDir, env, timeout_ms, spawn });
    results.push(result);
    if (!result.ok && gate.required === true) break;
  }
  const failed = results.find((result) => !result.ok && result.required === true);
  const summary = {
    ok: !failed,
    stage: 'ralph_gate_runner',
    reason: failed ? failed.reason : null,
    failed_gate: failed?.id || null,
    gates: results.map(summarizeResult),
    commands_executed: results.map((result) => commandPreview(gates.find((gate) => gate.id === result.id))).filter(Boolean),
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: failed ? 'fix_failed_gate' : 'continue_after_green_gates'
  };
  appendExecutionLog({ event: summary.ok ? 'gate_runner_completed' : 'gate_runner_failed', summary }, { rootDir });
  return summary;
}

module.exports = { DEFAULT_GATE_TIMEOUT_MS, GATE_SEQUENCE, FORBIDDEN_GATE_TOKENS, validateGate, describeGateSequence, runGate, runGateSequence };
