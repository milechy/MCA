const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createLiveValidationReport,
  recordLiveValidationResult,
  writeLiveValidationReport,
  defaultReportPath
} = require('../../src/ralph/live-validation-report');
const { maybeRecord, parseArgs } = require('../../scripts/ralph/real-external-agent-smoke');
const { main } = require('../../src/ralph/cli');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-live-validation-report-'));
}

function blockedSmoke() {
  return {
    ok: false,
    skipped: false,
    blocked: true,
    stage: 'real_external_agent_smoke',
    reason: 'provider_rate_limited',
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
      opencode_execution_started: true
    }
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
    candidate_patch_available: false,
    safe_side_effects: true,
    working_tree_clean_after: true,
    decision: 'hold_before_level_2_provider_blocked',
    next_action: 'retry_level_1_after_provider_recovers'
  });
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

test('parseArgs supports json-out and record-level', () => {
  expect(parseArgs(['--json-out', '.ralph/live-validation/out.json', '--record-level', '1'])).toEqual({
    json_out: '.ralph/live-validation/out.json',
    record_level: '1'
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
