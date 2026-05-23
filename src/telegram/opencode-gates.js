const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { readApproval } = require('../ralph/approval-manager');
const { calculatePatchHash } = require('./opencode-patch-approval');
const { changedFilesFromTouched, gitChangedFiles } = require('./opencode-apply');

const DEFAULT_TIMEOUT_MS = 180000;
const SECRET_LIKE_PATTERN = /(?:\b\d{8,}:[A-Za-z0-9_-]{20,}\b|ghp_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/]{32,}={0,2})/g;

// Phase 5 #2: known transient gate-failure signatures. When the daemon ran
// scripts/gates/run-all.sh during the Phase 4 PR_REVIEW smoke v2, ralph-tests
// failed once with stderr containing "error: Could not access './**'"
// repeated 15×. A manual rerun of the same patch + same suite passed cleanly,
// and an exhaustive trace of every git subprocess across the suite (333 git
// calls) showed no command passing './**' as a pathspec. The shape strongly
// suggests a subprocess race / shell-glob oddity that is not deterministically
// reproducible.
//
// Until we capture a reproducer, this pattern allows the operator to opt in
// (RALPH_GATE_RETRY_ON_FLAKE=1) to a SINGLE retry when the failure stderr
// matches a known flake signature. Genuine failures (real test/build/secret
// errors) do not match, so they will not be retried.
const KNOWN_TRANSIENT_FLAKE_PATTERNS = Object.freeze([
  /could not access\s+'[^']*\*\*[^']*'/i
]);

function isTransientGateFlake({ stdout, stderr } = {}) {
  const text = `${stdout || ''}\n${stderr || ''}`;
  return KNOWN_TRANSIENT_FLAKE_PATTERNS.some((re) => re.test(text));
}

// Phase 5 #2: when gates fail we previously kept only oneLine(stdout)/oneLine(stderr)
// — 600 chars each, newlines collapsed, no way to grep for the 15th "Could not
// access" or to see what failed. saveFullGateLog persists the raw streams to
// .ralph/logs/gate-failures/<approval_id>-<timestamp>.log so a post-mortem can
// see the actual sequence of errors and the surrounding context. Best-effort:
// failures here are swallowed (we never want gate-log persistence to itself
// fail the loop).
function gateFailureLogDir(rootDir) {
  return path.join(rootDir, '.ralph', 'logs', 'gate-failures');
}

function saveFullGateLog({ rootDir, approval_id, now, stdout, stderr, exit_code, attempt = 1 } = {}) {
  if (!rootDir || !approval_id) return null;
  try {
    const dir = gateFailureLogDir(rootDir);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = (now instanceof Date ? now : new Date()).toISOString().replace(/[:.]/g, '-');
    const filename = `${approval_id}-${stamp}-attempt${attempt}.log`;
    const filePath = path.join(dir, filename);
    const lines = [
      `# Gate failure log`,
      `# approval_id: ${approval_id}`,
      `# attempt: ${attempt}`,
      `# at: ${(now instanceof Date ? now : new Date()).toISOString()}`,
      `# exit_code: ${exit_code}`,
      `# ---- STDOUT ----`,
      String(stdout || ''),
      `# ---- STDERR ----`,
      String(stderr || '')
    ].join('\n');
    fs.writeFileSync(filePath, lines, 'utf8');
    return path.relative(rootDir, filePath);
  } catch (_err) {
    return null;
  }
}

function oneLine(value, maxLength = 600) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(SECRET_LIKE_PATTERN, '<redacted>');
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function durationMs(startedAt, finishedAt) {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return null;
  return Math.max(0, finished - started);
}

function blocked(reason, extra = {}) {
  const now = new Date().toISOString();
  return {
    ok: false,
    stage: 'opencode_gates',
    reason,
    approval_id: extra.approval_id || null,
    patch_hash: extra.patch_hash || null,
    candidate_patch_path: extra.candidate_patch_path || null,
    command: 'scripts/gates/run-all.sh',
    exit_code: null,
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    execution_connected: false,
    gates_started: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'fix_opencode_gates_preflight_failure'
  };
}

function opencodeGatesPreflight({ rootDir = process.cwd(), approval_id, patch_hash } = {}) {
  if (!approval_id) return blocked('approval_id_required');
  let approval;
  try {
    approval = readApproval(rootDir, approval_id);
  } catch {
    return blocked('approval_not_found', { approval_id });
  }

  const base = {
    approval_id,
    patch_hash: patch_hash || null,
    candidate_patch_path: approval.candidate_patch_path || null
  };
  if (approval.status !== 'approved') return blocked('approval_not_approved', base);
  if (approval.requested_action !== 'opencode_candidate_patch_apply') return blocked('requested_action_not_apply', base);
  if (!approval.patch_hash || patch_hash !== approval.patch_hash) return blocked('patch_hash_mismatch', { ...base, patch_hash, expected_patch_hash: approval.patch_hash });
  if (calculatePatchHash(rootDir, approval) !== approval.patch_hash) return blocked('candidate_patch_hash_mismatch', base);

  const repositoryFilesModified = changedFilesFromTouched(approval.files_touched || [], rootDir);
  if (repositoryFilesModified.length === 0) return blocked('applied_files_missing', base);

  return {
    ok: true,
    stage: 'opencode_gates_preflight',
    reason: null,
    approval_id,
    patch_hash: approval.patch_hash,
    candidate_patch_path: approval.candidate_patch_path,
    files_touched: approval.files_touched || [],
    repository_files_modified: repositoryFilesModified,
    git_status_files: gitChangedFiles(rootDir),
    command: 'scripts/gates/run-all.sh',
    execution_connected: false,
    commands_executed: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'run_local_gates_for_applied_patch'
  };
}

function runOpenCodeAppliedPatchGates({
  rootDir = process.cwd(),
  approval_id,
  patch_hash,
  timeout_ms = DEFAULT_TIMEOUT_MS,
  now = () => new Date(),
  // Phase 5 #2: injectable for tests; production keeps the real child_process.
  spawn = spawnSync,
  env = process.env
} = {}) {
  const preflight = opencodeGatesPreflight({ rootDir, approval_id, patch_hash });
  if (!preflight.ok) return { ...preflight, stage: 'opencode_gates' };

  const runOnce = (attempt) => {
    const startedAt = now().toISOString();
    const result = spawn('scripts/gates/run-all.sh', [], {
      cwd: rootDir,
      encoding: 'utf8',
      timeout: timeout_ms,
      maxBuffer: 1024 * 1024
    });
    const finishedAt = now().toISOString();
    const exitCode = typeof result.status === 'number' ? result.status : null;
    const timedOut = result.error && result.error.code === 'ETIMEDOUT';
    const ok = exitCode === 0 && !timedOut;
    return { result, startedAt, finishedAt, exitCode, timedOut, ok, attempt };
  };

  let attempt = 1;
  let run = runOnce(attempt);

  // Phase 5 #2: opt-in retry on known transient flakes. RALPH_GATE_RETRY_ON_FLAKE=1
  // turns this on. The retry triggers ONLY when:
  //   (a) the first run failed (ok === false),
  //   (b) the failure was NOT a timeout (transient timeouts have a different
  //       retry path elsewhere),
  //   (c) the stderr/stdout matches a known-flake pattern in
  //       KNOWN_TRANSIENT_FLAKE_PATTERNS, and
  //   (d) the parsed failed_gate is null (a structured FAILED_GATE=<name> line
  //       means we know which gate failed, so the failure is genuine, not a
  //       transient — never retry in that case).
  // Genuine failures do not match the flake patterns, so they short-circuit
  // here and surface normally.
  let retried = false;
  let firstAttemptLogPath = null;
  if (
    !run.ok &&
    !run.timedOut &&
    env.RALPH_GATE_RETRY_ON_FLAKE === '1' &&
    parseFailedGateName(run.result.stdout, run.result.stderr) === null &&
    isTransientGateFlake({ stdout: run.result.stdout, stderr: run.result.stderr })
  ) {
    firstAttemptLogPath = saveFullGateLog({
      rootDir,
      approval_id: preflight.approval_id,
      now: now(),
      stdout: run.result.stdout,
      stderr: run.result.stderr,
      exit_code: run.exitCode,
      attempt
    });
    attempt += 1;
    run = runOnce(attempt);
    retried = true;
  }

  const { result, startedAt, finishedAt, exitCode, timedOut, ok } = run;
  const repositoryFilesModified = changedFilesFromTouched(preflight.files_touched, rootDir);
  // Phase 1 #7 fix: scripts/gates/run-all.sh now emits a structured
  // [gate] FAILED_GATE=<name> line when any sub-gate fails. Parse it so the
  // wired loop's failure summary can report failed_gate by name rather than
  // null, and operator dashboards can group gate failures by gate.
  const failedGate = ok ? null : parseFailedGateName(result.stdout, result.stderr);

  // Phase 5 #2: on any non-ok outcome, persist the full streams so a
  // post-mortem can see the actual sequence — oneLine() in the summary
  // collapses newlines and truncates at 600 chars, hiding most of the
  // information needed to diagnose a real failure.
  const fullLogPath = !ok
    ? saveFullGateLog({
        rootDir,
        approval_id: preflight.approval_id,
        now: now(),
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: exitCode,
        attempt
      })
    : null;

  return {
    ok,
    stage: 'opencode_gates',
    reason: ok ? null : timedOut ? 'opencode_gates_timeout' : 'opencode_gates_failed',
    failed_gate: failedGate,
    preflight,
    approval_id: preflight.approval_id,
    patch_hash: preflight.patch_hash,
    candidate_patch_path: preflight.candidate_patch_path,
    command: 'scripts/gates/run-all.sh',
    exit_code: exitCode,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs(startedAt, finishedAt),
    stdout_preview: oneLine(result.stdout),
    stderr_preview: oneLine(result.stderr || result.error?.message || ''),
    // Phase 5 #2: full streams written to disk for post-mortem. Null when the
    // gate passed (no failure to investigate) or the writes themselves failed.
    full_log_path: fullLogPath,
    first_attempt_log_path: firstAttemptLogPath,
    retried_on_flake: retried,
    attempts: attempt,
    execution_connected: true,
    gates_started: true,
    commands_executed: ['scripts/gates/run-all.sh'],
    files_modified: repositoryFilesModified,
    repository_files_modified: repositoryFilesModified,
    git_status_files: gitChangedFiles(rootDir),
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: ok ? 'review_diff_then_commit_with_operator_approval' : 'fix_gates_failure_before_commit'
  };
}

// Real gate names are kebab-case (pre-secret-scan, ralph-tests, supabase-local,
// playwright-e2e, etc.). Requiring at least one hyphen rejects accidental
// shell-tokens like "rm" if someone tried to slip them through FAILED_GATE=.
// The downstream consumer just renders the name into JSON; shell-quoting is
// not required, but the regex stays narrow so any future caller cannot use it
// as a free-form metadata channel.
const SAFE_GATE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)+$/;
function parseFailedGateName(stdout, stderr) {
  for (const stream of [stdout, stderr]) {
    if (!stream) continue;
    const m = String(stream).match(/\[gate\]\s*FAILED_GATE=([A-Za-z0-9_.-]+)/);
    if (m && SAFE_GATE_NAME.test(m[1])) return m[1];
  }
  return null;
}

module.exports = {
  opencodeGatesPreflight,
  runOpenCodeAppliedPatchGates,
  parseFailedGateName,
  oneLine,
  isTransientGateFlake,
  saveFullGateLog,
  KNOWN_TRANSIENT_FLAKE_PATTERNS
};
