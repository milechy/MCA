const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createLiveValidationReport,
  recordLiveValidationResult,
  writeLiveValidationReport,
  defaultReportPath,
  blockerKind,
  liveValidationStatus,
  liveValidationBackoffGuard
} = require('../../src/ralph/live-validation-report');
const { maybeRecord, parseArgs } = require('../../scripts/ralph/real-external-agent-smoke');
const { main } = require('../../src/ralph/cli');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-live-validation-report-'));
}

function blockedSmoke(overrides = {}) {
  const reason = overrides.reason || 'provider_rate_limited';
  return {
    ok: false,
    skipped: false,
    blocked: overrides.blocked !== undefined ? overrides.blocked : true,
    stage: 'real_external_agent_smoke',
    reason,
    gateway_type: 'nemoclaw',
    gateway_name: 'nemoclaw',
    opencode_runtime_mode: 'nemoclaw-mediated',
    mediator: 'nemoclaw',
    job_id: 'JOB-EXTAGENT-REPORT',
    approval_id: 'APR-EXTAGENT-REPORT',
    sandbox_root: '.ralph/tmp/external-agent-smoke/APR-EXTAGENT-REPORT',
    candidate_patch_path: null,
    runtime_installed: true,
    working_tree_clean_before: true,
    working_tree_clean_after: true,
    execution_connected: true,
    real_gateway_process_started: true,
    apply_allowed: false,
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false,
    cleanup: {
      kept: false,
      removed: [
        '.ralph/external-agent-jobs/JOB-EXTAGENT-REPORT.json',
        '.ralph/tmp/external-agent-smoke/APR-EXTAGENT-REPORT'
      ],
      skipped: []
    },
    next_action: 'retry_level_1_after_provider_recovers_or_record_blocked_outcome',
    run: {
      command_preview: 'openshell sandbox exec --message FAKE_SECRET_VALUE_FOR_REDACTION_TEST',
      stderr_preview: 'provider limited with token FAKE_GITHUB_TOKEN_FOR_REDACTION_TEST',
      stdout_preview: '',
      commands_executed: ['openshell sandbox exec --message very long command'],
      opencode_execution_started: true,
      reason
    },
    ...overrides
  };
}

function captureMain(argv, options = {}) {
  const lines = [];
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  process.exitCode = 0;
  console.log = (value) => lines.push(String(value));
  try {
    main(argv, options);
  } finally {
    console.log = originalLog;
  }
  const exitCode = process.exitCode || 0;
  process.exitCode = originalExitCode;
  return { exitCode, output: lines.join('\n'), json: lines.length ? JSON.parse(lines.join('\n')) : null };
}

test('createLiveValidationReport records provider blocker as hold before level 2', () => {
  const report = createLiveValidationReport({
    level: 1,
    smoke_result: blockedSmoke(),
    now: new Date('2026-05-12T03:00:00.000Z')
  });

  expect(report).toMatchObject({
    ok: true,
    stage: 'ralph_live_validation_report',
    version: 'live_validation_report_v0_1',
    level: 1,
    provider_blocked: true,
    provider_blocker_reason: 'provider_rate_limited',
    runtime_blocked: false,
    transient_blocked: true,
    transient_blocker_kind: 'provider',
    candidate_patch_available: false,
    safe_side_effects: true,
    working_tree_clean_after: true,
    decision: 'hold_before_level_2_provider_blocked',
    next_action: 'retry_level_1_after_provider_recovers'
  });
});

test('createLiveValidationReport records runtime timeout as hold before level 2', () => {
  const report = createLiveValidationReport({
    level: 1,
    smoke_result: blockedSmoke({ reason: 'nemoclaw_runtime_timeout', blocked: false }),
    now: new Date('2026-05-12T05:25:00.000Z')
  });

  expect(report).toMatchObject({
    ok: true,
    level: 1,
    provider_blocked: false,
    provider_blocker_reason: null,
    runtime_blocked: true,
    runtime_blocker_reason: 'nemoclaw_runtime_timeout',
    transient_blocked: true,
    transient_blocker_kind: 'runtime',
    candidate_patch_available: false,
    safe_side_effects: true,
    decision: 'hold_before_level_2_runtime_blocked',
    next_action: 'retry_level_1_after_runtime_recovers'
  });
});

test('blockerKind distinguishes provider runtime and non transient reasons', () => {
  expect(blockerKind('provider_rate_limited')).toBe('provider');
  expect(blockerKind('nemoclaw_runtime_timeout')).toBe('runtime');
  expect(blockerKind('unexpected_failure')).toBe(null);
});

test('recordLiveValidationResult writes report under .ralph/live-validation', () => {
  const rootDir = tmpRoot();
  const result = recordLiveValidationResult({
    rootDir,
    level: 1,
    smoke_result: blockedSmoke(),
    output_path: '.ralph/live-validation/level-1-report.json',
    now: new Date('2026-05-12T03:01:00.000Z')
  });

  expect(result).toMatchObject({
    ok: true,
    decision: 'hold_before_level_2_provider_blocked',
    output: {
      ok: true,
      output_path: '.ralph/live-validation/level-1-report.json'
    }
  });
  const saved = JSON.parse(fs.readFileSync(path.join(rootDir, '.ralph/live-validation/level-1-report.json'), 'utf8'));
  expect(saved).toMatchObject({ level: 1, provider_blocked: true });
});

test('liveValidationStatus reports active backoff from latest transient blocker report', () => {
  const rootDir = tmpRoot();
  recordLiveValidationResult({
    rootDir,
    level: 1,
    smoke_result: blockedSmoke(),
    output_path: '.ralph/live-validation/level-1-report.json',
    now: new Date('2026-05-12T03:00:00.000Z')
  });

  const status = liveValidationStatus({
    rootDir,
    level: 1,
    now: new Date('2026-05-12T03:10:00.000Z'),
    backoff_ms: 30 * 60 * 1000
  });

  expect(status).toMatchObject({
    ok: true,
    stage: 'ralph_live_validation_status',
    level: 1,
    report_path: '.ralph/live-validation/level-1-report.json',
    transient_blocked: true,
    transient_blocker_kind: 'provider',
    provider_blocker_reason: 'provider_rate_limited',
    backoff_active: true,
    next_retry_after: '2026-05-12T03:30:00.000Z',
    next_action: 'wait_until_next_retry_after'
  });
});

test('liveValidationBackoffGuard blocks retry while backoff is active', () => {
  const rootDir = tmpRoot();
  recordLiveValidationResult({
    rootDir,
    level: 1,
    smoke_result: blockedSmoke({ reason: 'nemoclaw_runtime_timeout', blocked: false }),
    output_path: '.ralph/live-validation/level-1-runtime.json',
    now: new Date('2026-05-12T05:00:00.000Z')
  });

  const guard = liveValidationBackoffGuard({
    rootDir,
    level: 1,
    now: new Date('2026-05-12T05:05:00.000Z'),
    backoff_ms: 30 * 60 * 1000
  });

  expect(guard).toMatchObject({
    ok: false,
    reason: 'recent_transient_blocker_backoff_active',
    transient_blocker_kind: 'runtime',
    runtime_blocker_reason: 'nemoclaw_runtime_timeout',
    next_retry_after: '2026-05-12T05:30:00.000Z',
    execution_connected: false,
    real_gateway_process_started: false,
    apply_allowed: false,
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false
  });
});

test('CLI live-validation-status prints bounded status', () => {
  const rootDir = tmpRoot();
  recordLiveValidationResult({
    rootDir,
    level: 1,
    smoke_result: blockedSmoke(),
    output_path: '.ralph/live-validation/level-1-cli.json',
    now: new Date('2026-05-12T06:00:00.000Z')
  });

  const result = captureMain([
    'live-validation-status',
    '--level', '1',
    '--backoff-ms', String(30 * 60 * 1000)
  ], { rootDir, now: new Date('2026-05-12T06:10:00.000Z') });

  expect(result.exitCode).toBe(0);
  expect(result.json).toMatchObject({
    ok: true,
    stage: 'ralph_live_validation_status',
    report_path: '.ralph/live-validation/level-1-cli.json',
    backoff_active: true,
    next_action: 'wait_until_next_retry_after'
  });
});

test('writeLiveValidationReport refuses paths outside live validation directory', () => {
  const result = writeLiveValidationReport({
    rootDir: tmpRoot(),
    report: { ok: true },
    output_path: '.ralph/stories/not-allowed.json'
  });
  expect(result).toMatchObject({ ok: false, reason: 'output_path_not_allowed' });
});

test('defaultReportPath uses level and timestamp', () => {
  expect(defaultReportPath({ level: 1, now: new Date('2026-05-12T03:02:03.000Z') })).toBe('.ralph/live-validation/level-1-20260512030203.json');
});

test('maybeRecord attaches validation report output metadata', () => {
  const rootDir = tmpRoot();
  const { result, record } = maybeRecord(blockedSmoke(), {
    rootDir,
    json_out: '.ralph/live-validation/smoke-report.json',
    record_level: 1
  });

  expect(result.validation_report).toMatchObject({ ok: true, output_path: '.ralph/live-validation/smoke-report.json' });
  expect(record).toMatchObject({ ok: true, decision: 'hold_before_level_2_provider_blocked' });
  expect(fs.existsSync(path.join(rootDir, '.ralph/live-validation/smoke-report.json'))).toBe(true);
});

test('parseArgs supports json-out record-level and respect-last-report', () => {
  expect(parseArgs(['--json-out', '.ralph/live-validation/out.json', '--record-level', '1', '--respect-last-report', '--backoff-ms', '60000'])).toEqual({
    json_out: '.ralph/live-validation/out.json',
    record_level: '1',
    respect_last_report: true,
    backoff_ms: '60000'
  });
});

test('CLI record-live-validation-result writes bounded report', () => {
  const rootDir = tmpRoot();
  const inputPath = path.join(rootDir, 'smoke.json');
  fs.writeFileSync(inputPath, `${JSON.stringify(blockedSmoke(), null, 2)}\n`, 'utf8');

  const result = captureMain([
    'record-live-validation-result',
    '--level', '1',
    '--input', inputPath,
    '--output', '.ralph/live-validation/cli-report.json'
  ], { rootDir, now: new Date('2026-05-12T03:03:00.000Z') });

  expect(result.exitCode).toBe(0);
  expect(result.json).toMatchObject({
    ok: true,
    decision: 'hold_before_level_2_provider_blocked',
    output: { ok: true, output_path: '.ralph/live-validation/cli-report.json' }
  });
  expect(fs.existsSync(path.join(rootDir, '.ralph/live-validation/cli-report.json'))).toBe(true);
});
