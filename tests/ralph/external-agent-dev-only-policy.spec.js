const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  GATEWAY_ACTIONS,
  GATEWAY_TYPES,
  OPENCODE_RUNTIME_MODES,
  buildExternalGatewayPolicy,
  devOnlyGatewayAllowed,
  gatewayIsDevOnly,
  runtimeModeForGateway
} = require('../../src/ralph/external-agent-gateway');
const { runExternalAgentCandidatePatch } = require('../../src/ralph/external-agent-adapter');
const { runGatewayCandidatePatch, runRealExternalAgentSmoke } = require('../../scripts/ralph/real-external-agent-smoke');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-external-agent-dev-only-'));
}

function spawnSuccessWithPatch() {
  return (_command, args, options = {}) => {
    if (!args.includes('--version')) fs.writeFileSync(path.join(options.cwd, 'candidate.patch'), 'diff --git a/tests/generated.js b/tests/generated.js\n');
    return { status: 0, stdout: 'ok', stderr: '' };
  };
}

test('external gateway policy treats NemoClaw as mediated default', () => {
  const policy = buildExternalGatewayPolicy({
    gateway_type: GATEWAY_TYPES.NEMOCLAW,
    gateway_name: 'nemoclaw',
    action: GATEWAY_ACTIONS.RUN_CANDIDATE_PATCH,
    sandbox_root: '.ralph/tmp/external-agent/APR-1',
    requested_paths: ['tests/generated.js'],
    task: 'Generate candidate.patch only.'
  });

  expect(policy).toMatchObject({
    ok: true,
    gateway_type: GATEWAY_TYPES.NEMOCLAW,
    mediator: 'nemoclaw',
    opencode_runtime_mode: OPENCODE_RUNTIME_MODES.NEMOCLAW_MEDIATED,
    dev_only_gateway: false,
    candidate_patch_path: '.ralph/tmp/external-agent/APR-1/candidate.patch',
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    secret_display_allowed: false,
    secret_persistence_allowed: false
  });
});

test('external gateway policy blocks non-NemoClaw gateways unless explicitly opted in', () => {
  const blocked = buildExternalGatewayPolicy({
    gateway_type: GATEWAY_TYPES.OPENCLAW,
    gateway_name: 'openclaw',
    action: GATEWAY_ACTIONS.RUN_CANDIDATE_PATCH,
    sandbox_root: '.ralph/tmp/external-agent/APR-2',
    requested_paths: ['tests/generated.js'],
    task: 'Generate candidate.patch only.'
  });
  expect(blocked).toMatchObject({
    ok: false,
    reason: 'dev_only_gateway_requires_explicit_opt_in',
    gateway_type: GATEWAY_TYPES.OPENCLAW,
    opencode_runtime_mode: OPENCODE_RUNTIME_MODES.DEV_ONLY_NON_NEMOCLAW,
    dev_only_gateway: true,
    execution_allowed: false
  });

  const allowed = buildExternalGatewayPolicy({
    gateway_type: GATEWAY_TYPES.OPENCLAW,
    gateway_name: 'openclaw',
    action: GATEWAY_ACTIONS.RUN_CANDIDATE_PATCH,
    sandbox_root: '.ralph/tmp/external-agent/APR-2',
    requested_paths: ['tests/generated.js'],
    task: 'Generate candidate.patch only.',
    allow_dev_only_gateway: true
  });
  expect(allowed).toMatchObject({
    ok: true,
    opencode_runtime_mode: OPENCODE_RUNTIME_MODES.DEV_ONLY_NON_NEMOCLAW,
    dev_only_gateway: true,
    next_action: 'run_dev_only_gateway_inside_approved_sandbox'
  });
});

test('dev-only helpers expose explicit non-default behavior', () => {
  expect(gatewayIsDevOnly(GATEWAY_TYPES.NEMOCLAW)).toBe(false);
  expect(gatewayIsDevOnly(GATEWAY_TYPES.OPENCLAW)).toBe(true);
  expect(runtimeModeForGateway(GATEWAY_TYPES.NEMOCLAW)).toBe(OPENCODE_RUNTIME_MODES.NEMOCLAW_MEDIATED);
  expect(runtimeModeForGateway(GATEWAY_TYPES.OPENCLAW)).toBe(OPENCODE_RUNTIME_MODES.DEV_ONLY_NON_NEMOCLAW);
  expect(devOnlyGatewayAllowed({ allow_dev_only_gateway: false, env: {} })).toBe(false);
  expect(devOnlyGatewayAllowed({ allow_dev_only_gateway: true, env: {} })).toBe(true);
  expect(devOnlyGatewayAllowed({ env: { RALPH_EXTERNAL_AGENT_DEV_ONLY_GATEWAY_ALLOWED: 'true' } })).toBe(true);
});

test('external adapter blocks OpenClaw before runtime without explicit dev-only opt-in', () => {
  const rootDir = tmpRoot();
  const calls = [];
  const result = runExternalAgentCandidatePatch({
    rootDir,
    approval_id: 'APR-DEV-BLOCK',
    job_id: 'JOB-DEV-BLOCK',
    gateway_type: 'openclaw',
    gateway_name: 'openclaw',
    sandbox_root: '.ralph/tmp/external-agent/APR-DEV-BLOCK',
    requested_paths: ['tests/generated.js'],
    task: 'Generate candidate.patch only.',
    command: 'openclaw',
    explicit_runtime_approval: true,
    spawn: (...args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; },
    record_job: false
  });

  expect(result).toMatchObject({
    ok: false,
    reason: 'dev_only_gateway_requires_explicit_opt_in',
    opencode_runtime_mode: OPENCODE_RUNTIME_MODES.DEV_ONLY_NON_NEMOCLAW,
    dev_only_gateway: true,
    execution_connected: false
  });
  expect(calls).toHaveLength(0);
});

test('external adapter can run OpenClaw only with explicit dev-only opt-in and runtime approval', () => {
  const rootDir = tmpRoot();
  const result = runExternalAgentCandidatePatch({
    rootDir,
    approval_id: 'APR-DEV-ALLOW',
    job_id: 'JOB-DEV-ALLOW',
    gateway_type: 'openclaw',
    gateway_name: 'openclaw',
    sandbox_root: '.ralph/tmp/external-agent/APR-DEV-ALLOW',
    requested_paths: ['tests/generated.js'],
    task: 'Generate candidate.patch only.',
    command: 'openclaw',
    explicit_runtime_approval: true,
    allow_dev_only_gateway: true,
    spawn: spawnSuccessWithPatch(),
    record_job: false,
    now: () => new Date('2026-05-09T07:00:00.000Z')
  });

  expect(result).toMatchObject({
    ok: true,
    gateway_type: 'openclaw',
    mediator: 'openclaw',
    opencode_runtime_mode: OPENCODE_RUNTIME_MODES.DEV_ONLY_NON_NEMOCLAW,
    dev_only_gateway: true,
    candidate_patch_path: '.ralph/tmp/external-agent/APR-DEV-ALLOW/candidate.patch',
    repository_files_modified: [],
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    deploy_allowed: false,
    migration_allowed: false
  });
});

test('real external agent smoke blocks non-NemoClaw gateway unless explicitly opted in', () => {
  const rootDir = tmpRoot();
  const result = runRealExternalAgentSmoke({
    rootDir,
    gateway_type: 'openclaw',
    env: {},
    now: () => new Date('2026-05-09T07:10:00.000Z')
  });
  expect(result).toMatchObject({
    ok: false,
    reason: 'dev_only_gateway_requires_explicit_opt_in',
    gateway_type: 'openclaw',
    opencode_runtime_mode: OPENCODE_RUNTIME_MODES.DEV_ONLY_NON_NEMOCLAW,
    dev_only_gateway: true,
    execution_connected: false,
    next_action: 'rerun_with_explicit_dev_only_gateway_opt_in_or_use_nemoclaw'
  });
});

test('real smoke routes NemoClaw through NemoClaw OpenCode gateway', () => {
  const rootDir = tmpRoot();
  const result = runGatewayCandidatePatch({
    gateway: 'nemoclaw',
    rootDir,
    approvalId: 'APR-SMOKE-NEMO',
    jobId: 'JOB-SMOKE-NEMO',
    sandboxRoot: '.ralph/tmp/external-agent-smoke/APR-SMOKE-NEMO',
    requested_paths: ['tests/generated.js'],
    task: 'Generate candidate.patch only.',
    command: 'nemoclaw',
    env: {},
    timeout_ms: 60000,
    allow_dev_only_gateway: false,
    now: () => new Date('2026-05-09T07:20:00.000Z')
  });

  expect(result).toMatchObject({
    ok: false,
    reason: 'nemoclaw_runtime_not_installed',
    mediator: 'nemoclaw',
    opencode_runtime_mode: OPENCODE_RUNTIME_MODES.NEMOCLAW_MEDIATED,
    runtime_installed: false,
    execution_connected: false,
    real_gateway_process_started: false,
    opencode_execution_started: false,
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    deploy_allowed: false,
    migration_allowed: false
  });
});
