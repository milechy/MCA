const { test, expect } = require('@playwright/test');

const {
  GATEWAY_TYPES,
  GATEWAY_ACTIONS,
  normalizeGatewayType,
  normalizeGatewayName,
  normalizeRequestedPaths,
  sandboxCandidatePatchPath,
  buildExternalGatewayPolicy,
  gatewayRuntimeDependencyApproved
} = require('../../src/ralph/external-agent-gateway');

test('gateway normalization allows NemoClaw/OpenClaw/generic only', () => {
  expect(normalizeGatewayType('NemoClaw')).toBe(GATEWAY_TYPES.NEMOCLAW);
  expect(normalizeGatewayType('openclaw')).toBe(GATEWAY_TYPES.OPENCLAW);
  expect(normalizeGatewayType('generic')).toBe(GATEWAY_TYPES.GENERIC);
  expect(normalizeGatewayType('shell')).toBe(null);
  expect(normalizeGatewayName('nemoclaw-main')).toBe('nemoclaw-main');
  expect(normalizeGatewayName('../bad')).toBe(null);
});

test('requested paths and sandbox candidate path are constrained', () => {
  expect(normalizeRequestedPaths(['tests/a.spec.js', '../bad', '/tmp/x', 'src/foo.js'])).toEqual(['tests/a.spec.js', 'src/foo.js']);
  expect(sandboxCandidatePatchPath('.ralph/tmp/opencode-sandbox/APR-1')).toBe('.ralph/tmp/opencode-sandbox/APR-1/candidate.patch');
  expect(sandboxCandidatePatchPath('../bad')).toBe(null);
  expect(sandboxCandidatePatchPath('/tmp/bad')).toBe(null);
});

test('buildExternalGatewayPolicy permits candidate.patch generation only', () => {
  const policy = buildExternalGatewayPolicy({
    gateway_type: 'nemoclaw',
    gateway_name: 'nemoclaw-main',
    action: GATEWAY_ACTIONS.RUN_CANDIDATE_PATCH,
    sandbox_root: '.ralph/tmp/opencode-sandbox/APR-1',
    requested_paths: ['tests/generated.spec.js'],
    task: 'add one test'
  });

  expect(policy).toMatchObject({
    ok: true,
    status: 'ready',
    stage: 'external_agent_gateway_policy',
    reason: null,
    gateway_type: 'nemoclaw',
    gateway_name: 'nemoclaw-main',
    action: 'run_candidate_patch',
    sandbox_root: '.ralph/tmp/opencode-sandbox/APR-1',
    candidate_patch_path: '.ralph/tmp/opencode-sandbox/APR-1/candidate.patch',
    requested_paths: ['tests/generated.spec.js'],
    execution_allowed: true,
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    unrestricted_shell_allowed: false,
    raw_log_allowed: false,
    persistent_credentials_allowed: false,
    requires_telegram_authorization: true,
    requires_ralph_approval: true,
    requires_sandbox_preflight: true,
    requires_candidate_patch_preview: true,
    bounded_metadata_only: true
  });
  expect(policy.allowed_outputs).toEqual(['.ralph/tmp/opencode-sandbox/APR-1/candidate.patch']);
});

test('buildExternalGatewayPolicy blocks unsafe or incomplete requests', () => {
  expect(buildExternalGatewayPolicy({ gateway_type: 'shell', gateway_name: 'shell', action: GATEWAY_ACTIONS.RUN_CANDIDATE_PATCH, sandbox_root: '.ralph/tmp/x', requested_paths: ['tests/x.js'], task: 'x' }).reason).toBe('gateway_type_not_allowed');
  expect(buildExternalGatewayPolicy({ gateway_type: 'nemoclaw', gateway_name: 'nemoclaw', action: 'deploy', sandbox_root: '.ralph/tmp/x', requested_paths: ['tests/x.js'], task: 'x' }).reason).toBe('gateway_action_not_allowed');
  expect(buildExternalGatewayPolicy({ gateway_type: 'nemoclaw', gateway_name: 'nemoclaw', action: GATEWAY_ACTIONS.RUN_CANDIDATE_PATCH, sandbox_root: '../bad', requested_paths: ['tests/x.js'], task: 'x' }).reason).toBe('sandbox_root_not_allowed');
  expect(buildExternalGatewayPolicy({ gateway_type: 'nemoclaw', gateway_name: 'nemoclaw', action: GATEWAY_ACTIONS.RUN_CANDIDATE_PATCH, sandbox_root: '.ralph/tmp/x', requested_paths: [], task: 'x' }).reason).toBe('requested_paths_required');
});

test('gateway runtime dependency requires separate approval', () => {
  const policy = buildExternalGatewayPolicy({ gateway_type: 'openclaw', gateway_name: 'openclaw', action: GATEWAY_ACTIONS.RUN_CANDIDATE_PATCH, sandbox_root: '.ralph/tmp/opencode-sandbox/APR-1', requested_paths: ['tests/x.js'], task: 'x' });
  expect(gatewayRuntimeDependencyApproved(policy)).toMatchObject({
    ok: false,
    reason: 'runtime_dependency_requires_separate_approval',
    runtime_dependency_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    unrestricted_shell_allowed: false
  });
  expect(gatewayRuntimeDependencyApproved(policy, { explicit_runtime_approval: true })).toMatchObject({ ok: true, reason: null, runtime_dependency_allowed: true });
});
