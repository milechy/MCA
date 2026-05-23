const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStory, readStory } = require('../../src/ralph/story-queue');
const { tickAutonomousLoop, LOOP_PHASES, taskForStory } = require('../../src/ralph/autonomous-loop');
const {
  FAILURE_TYPES,
  classifyFailure,
  buildRepairDecision,
  extractTargetFiles,
  appendRepairHistory,
  redactText
} = require('../../src/ralph/repair-strategy');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-repair-strategy-'));
}

function createGateStory(rootDir, overrides = {}) {
  const created = createStory({
    story_id: overrides.story_id || 'STORY-REPAIR',
    title: 'Repair failing gate',
    requirement: 'Fix the failing Ralph test gate.',
    requested_paths: ['src/ralph/autonomous-loop.js', 'tests/ralph/repair-strategy.spec.js'],
    status: 'running',
    current_phase: LOOP_PHASES.GATES,
    attempts: overrides.attempts ?? 0,
    max_attempts: overrides.max_attempts ?? 3,
    last_ultraplan: {
      planned_files: ['src/ralph/repair-strategy.js'],
      tasks: [
        { id: 'TASK-002', agent: 'opencode', objective: 'Implement repair strategy integration.' }
      ]
    }
  }, { rootDir, now: new Date('2026-05-09T02:00:00.000Z') });
  expect(created.ok).toBe(true);
  return created.story.story_id;
}

function fakeSecret() {
  return ['sk', 'repair', 'abcdefghijklmnopqrstuvwxyz'].join('-');
}

test('classifyFailure detects supported gate failure types', () => {
  expect(classifyFailure({ failed_gate: 'ralph-tests', stderr_preview: 'test failed assertion' })).toBe(FAILURE_TYPES.TEST);
  expect(classifyFailure({ failed_gate: 'typecheck', stderr_preview: 'tsc TypeScript error' })).toBe(FAILURE_TYPES.TYPECHECK);
  expect(classifyFailure({ failed_gate: 'build', stderr_preview: 'build failed' })).toBe(FAILURE_TYPES.BUILD);
  expect(classifyFailure({ failed_gate: 'pre-secret-scan', stdout_preview: 'potential secret detected' })).toBe(FAILURE_TYPES.SECRET_SCAN);
  expect(classifyFailure({ failed_gate: 'supabase-local', stderr_preview: 'migration failed' })).toBe(FAILURE_TYPES.MIGRATION);
  expect(classifyFailure({ failed_gate: 'playwright-regression', stderr_preview: 'browser page error' })).toBe(FAILURE_TYPES.E2E);
  expect(classifyFailure({ reason: 'gate_timeout', stderr_preview: 'process timed out' })).toBe(FAILURE_TYPES.TIMEOUT);
  expect(classifyFailure({ failed_gate: 'db-policy', stderr_preview: 'production DB destructive migration requested DROP TABLE customers' })).toBe(FAILURE_TYPES.PRODUCTION_DB);
  expect(classifyFailure({ failed_gate: 'rls-policy', stderr_preview: 'ALTER TABLE accounts DISABLE ROW LEVEL SECURITY' })).toBe(FAILURE_TYPES.RLS_DISABLE);
});

test('buildRepairDecision creates bounded repair instruction and target files', () => {
  const secretFixture = fakeSecret();
  const decision = buildRepairDecision({
    story: {
      story_id: 'STORY-REPAIR',
      title: 'Repair test',
      requested_paths: ['src/ralph/repair-strategy.js'],
      last_ultraplan: { planned_files: ['tests/ralph/repair-strategy.spec.js'] },
      max_attempts: 3
    },
    failure: {
      failed_gate: 'ralph-tests',
      reason: 'gate_failed',
      stdout_preview: '1 failed assertion',
      stderr_preview: `Contact root@example.com password: hunter2 ${secretFixture}`,
      repository_files_modified: ['src/ralph/repair-strategy.js']
    },
    attempts: 1,
    now: new Date('2026-05-09T03:00:00.000Z')
  });

  expect(decision).toMatchObject({
    ok: true,
    failure_type: FAILURE_TYPES.TEST,
    escalation_required: false,
    next_action: 'dispatch_opencode_fix_candidate_patch_via_nemoclaw'
  });
  expect(decision.target_files).toEqual(expect.arrayContaining(['src/ralph/repair-strategy.js', 'tests/ralph/repair-strategy.spec.js']));
  expect(decision.repair_instruction).toContain('Repair failure type: test_failure');
  expect(decision.repair_instruction).toContain('Do not expose raw logs or secrets');
  expect(decision.repair_instruction).not.toContain('root@example.com');
  expect(decision.repair_instruction).not.toContain('hunter2');
  expect(decision.repair_instruction).not.toContain(secretFixture);
});

test('security sensitive failure types escalate immediately', () => {
  for (const [failure, expectedType] of [
    [{ failed_gate: 'post-secret-scan', stdout_preview: 'potential secret detected' }, FAILURE_TYPES.SECRET_SCAN],
    [{ failed_gate: 'policy', stderr_preview: 'security policy violation forbidden' }, FAILURE_TYPES.SECURITY_POLICY],
    [{ failed_gate: 'supabase-local', stderr_preview: 'migration failed' }, FAILURE_TYPES.MIGRATION],
    [{ failed_gate: 'db-policy', stderr_preview: 'production db destructive migration DROP TABLE customers' }, FAILURE_TYPES.PRODUCTION_DB],
    [{ failed_gate: 'rls-policy', stderr_preview: 'disable RLS on public.accounts' }, FAILURE_TYPES.RLS_DISABLE]
  ]) {
    const decision = buildRepairDecision({ story: { story_id: 'STORY-SECURITY' }, failure, attempts: 1, max_attempts: 3 });
    expect(decision.failure_type).toBe(expectedType);
    expect(decision.escalation_required).toBe(true);
    expect(decision.immediate_escalation).toBe(true);
    expect(decision.effective_cap).toBe(0);
    expect(decision.next_action).toBe('human_escalation_required');
  }
});

test('failure type caps can exhaust repair attempts before story max attempts', () => {
  const decision = buildRepairDecision({
    story: { story_id: 'STORY-TIMEOUT', max_attempts: 3 },
    failure: { reason: 'gate_timeout', stderr_preview: 'timeout' },
    attempts: 1,
    max_attempts: 3
  });
  expect(decision.failure_type).toBe(FAILURE_TYPES.TIMEOUT);
  expect(decision.effective_cap).toBe(1);
  expect(decision.escalation_required).toBe(true);
  expect(decision.repair_event.reason).toBe('repair_attempt_cap_exhausted');
});

test('appendRepairHistory keeps a bounded recent history', () => {
  const story = { repair_history: Array.from({ length: 30 }, (_, index) => ({ index })) };
  const history = appendRepairHistory(story, { index: 31 });
  expect(history).toHaveLength(25);
  expect(history[0].index).toBe(6);
  expect(history[24].index).toBe(31);
});

test('tickAutonomousLoop records repair history and moves test failures to FIX_LOOP', () => {
  const rootDir = tmpRoot();
  const storyId = createGateStory(rootDir);

  const result = tickAutonomousLoop({
    rootDir,
    story_id: storyId,
    now: new Date('2026-05-09T04:00:00.000Z'),
    gate_runner: () => ({
      ok: false,
      stage: 'ralph_gate_runner',
      reason: 'gate_failed',
      failed_gate: 'ralph-tests',
      stdout_preview: '1 test failed',
      stderr_preview: 'expect(received).toBe(expected)',
      commands_executed: ['bash scripts/gates/ralph-tests.sh'],
      repository_files_modified: ['src/ralph/autonomous-loop.js']
    })
  });

  expect(result).toMatchObject({
    ok: false,
    to_phase: LOOP_PHASES.FIX_LOOP,
    next_action: 'dispatch_opencode_fix_candidate_patch_via_nemoclaw',
    repair: {
      failure_type: FAILURE_TYPES.TEST,
      escalation_required: false
    }
  });
  const story = readStory(rootDir, storyId);
  expect(story).toMatchObject({
    current_phase: LOOP_PHASES.FIX_LOOP,
    attempts: 1,
    last_repair_type: FAILURE_TYPES.TEST
  });
  expect(story.repair_history).toHaveLength(1);
  expect(story.last_repair_instruction).toContain('Repair failure type: test_failure');
  expect(taskForStory(story)).toContain('Repair failure type: test_failure');
});

test('tickAutonomousLoop escalates secret scan failures without repair dispatch', () => {
  const rootDir = tmpRoot();
  const storyId = createGateStory(rootDir, { story_id: 'STORY-SECRET' });

  const result = tickAutonomousLoop({
    rootDir,
    story_id: storyId,
    now: new Date('2026-05-09T04:30:00.000Z'),
    gate_runner: () => ({
      ok: false,
      stage: 'ralph_gate_runner',
      reason: 'gate_failed',
      failed_gate: 'post-secret-scan',
      stdout_preview: 'potential secret detected in target',
      commands_executed: ['bash scripts/gates/secret-scan.sh']
    })
  });

  expect(result).toMatchObject({
    ok: false,
    to_phase: LOOP_PHASES.ESCALATED,
    next_action: 'human_escalation_required',
    repair: {
      failure_type: FAILURE_TYPES.SECRET_SCAN,
      escalation_required: true,
      immediate_escalation: true
    }
  });
  const story = readStory(rootDir, storyId);
  expect(story.current_phase).toBe(LOOP_PHASES.ESCALATED);
  expect(story.last_repair_instruction).toBe(null);
  expect(story.repair_history[0]).toMatchObject({ failure_type: FAILURE_TYPES.SECRET_SCAN, escalation_required: true });
});

test('redactText removes secret-shaped output from repair text', () => {
  const emailFixture = ['repair', 'example.com'].join('@');
  const secretFixture = fakeSecret();
  const longSecret = 'abcdefghijklmnopqrstuvwxyz1234567890ABCDEF';
  const text = redactText(`token=abc123 password: hunter2 contact ${emailFixture} ${secretFixture} ${longSecret}`);
  expect(text).not.toContain('hunter2');
  expect(text).not.toContain(emailFixture);
  expect(text).not.toContain(secretFixture);
  expect(text).not.toContain(longSecret);
});

test('extractTargetFiles ignores unsafe paths', () => {
  const files = extractTargetFiles({ repository_files_modified: ['/tmp/nope', '../bad', 'src/ok.js'] }, { requested_paths: ['tests/ok.spec.js'] });
  expect(files).toEqual(['src/ok.js', 'tests/ok.spec.js']);
});

// ============================================================
// Phase 5 #1: classifier field-aware (substring false-positive fix)
// ============================================================

const { classifyByFailedGate, shouldEscalateImmediately } = require('../../src/ralph/repair-strategy');

test('Phase 5 #1: classifyByFailedGate handles canonical gate names from scripts/gates', () => {
  expect(classifyByFailedGate('pre-secret-scan')).toBe(FAILURE_TYPES.SECRET_SCAN);
  expect(classifyByFailedGate('post-secret-scan')).toBe(FAILURE_TYPES.SECRET_SCAN);
  expect(classifyByFailedGate('ralph-tests')).toBe(FAILURE_TYPES.TEST);
  expect(classifyByFailedGate('telegram-tests')).toBe(FAILURE_TYPES.TEST);
  expect(classifyByFailedGate('supabase-local')).toBe(FAILURE_TYPES.MIGRATION);
  expect(classifyByFailedGate('playwright-e2e')).toBe(FAILURE_TYPES.E2E);
  expect(classifyByFailedGate('typecheck')).toBe(FAILURE_TYPES.TYPECHECK);
  expect(classifyByFailedGate('build')).toBe(FAILURE_TYPES.BUILD);
  expect(classifyByFailedGate('rls-policy')).toBe(FAILURE_TYPES.RLS_DISABLE);
  expect(classifyByFailedGate('db-policy')).toBe(FAILURE_TYPES.PRODUCTION_DB);
  expect(classifyByFailedGate('security-policy')).toBe(FAILURE_TYPES.SECURITY_POLICY);
});

test('Phase 5 #1: classifyByFailedGate returns null for unknown or empty gate names', () => {
  expect(classifyByFailedGate(null)).toBe(null);
  expect(classifyByFailedGate('')).toBe(null);
  expect(classifyByFailedGate(undefined)).toBe(null);
  expect(classifyByFailedGate('unrelated-gate-name')).toBe(null);
});

test('Phase 5 #1: regression — ralph-tests failure is NOT misclassified when stdout mentions earlier passing secret-scan gate', () => {
  // Exact shape captured from Phase 4 PR_REVIEW smoke v2 daemon log: the
  // pre-secret-scan gate PASSED, then ralph-tests FAILED, and the joined
  // stdout contained "[gate] passed: pre-secret-scan" which the OLD
  // classifier substring-matched as SECRET_SCAN → immediate_escalation.
  const failure = {
    failed_gate: 'ralph-tests',
    stage: 'opencode_gates',
    reason: 'opencode_gates_failed',
    command: 'scripts/gates/run-all.sh',
    stdout_preview: '[gate] start: pre-secret-scan [secret-scan] passed [gate] passed: pre-secret-scan [gate] start: ralph-tests [ralph-tests] running npm run test:ralph ...',
    stderr_preview: 'error: Could not access \'./**\'',
    exit_code: 1
  };
  expect(classifyFailure(failure)).toBe(FAILURE_TYPES.TEST);
  expect(shouldEscalateImmediately(classifyFailure(failure))).toBe(false);
});

test('Phase 5 #1: regression — ralph-tests stdout mentioning passing supabase-local gate does NOT classify as MIGRATION', () => {
  const failure = {
    failed_gate: 'ralph-tests',
    reason: 'opencode_gates_failed',
    stdout_preview: '[gate] passed: pre-secret-scan [gate] passed: supabase-local (SKIPPED) [gate] start: ralph-tests [ralph-tests] FAIL',
    stderr_preview: 'test failed: 1 of 589 tests failed'
  };
  expect(classifyFailure(failure)).toBe(FAILURE_TYPES.TEST);
  expect(shouldEscalateImmediately(classifyFailure(failure))).toBe(false);
});

test('Phase 5 #1: a real secret-scan gate failure still classifies as SECRET_SCAN and escalates', () => {
  // Sanity: the field-aware classifier must NOT regress on actual secret
  // exposure. failed_gate='pre-secret-scan' should still escalate immediately.
  const failure = {
    failed_gate: 'pre-secret-scan',
    stderr_preview: 'potential secret detected at src/foo.js:12',
    reason: 'gate_failed'
  };
  expect(classifyFailure(failure)).toBe(FAILURE_TYPES.SECRET_SCAN);
  expect(shouldEscalateImmediately(classifyFailure(failure))).toBe(true);
});

test('Phase 5 #1: when failed_gate is missing, fall back to focused text (stderr + reason) — NOT stdout', () => {
  // stdout contains a stale "potential secret detected" string from an
  // earlier passing gate. With failed_gate missing, the OLD classifier
  // would have matched that and escalated. The NEW classifier only looks
  // at stderr + reason in the fallback, so it ignores stdout-only leaks.
  const failure = {
    failed_gate: '',
    stage: 'opencode_gates',
    reason: 'opencode_gates_failed',
    stdout_preview: 'earlier gate said: potential secret detected (resolved)',
    stderr_preview: 'tests/foo.spec.js:42 expect(actual).toBe(expected) — assertion failed'
  };
  expect(classifyFailure(failure)).toBe(FAILURE_TYPES.TEST);
});

test('Phase 5 #1: focused-text fallback still escalates a real secret reported in stderr', () => {
  // The fallback path must still escalate when stderr genuinely reports
  // a secret detection. (failed_gate is missing so we go through fallback.)
  const failure = {
    failed_gate: null,
    stderr_preview: 'pre-secret-scan: potential secret detected at .env:1 — gh_pat_...',
    reason: 'gate_failed'
  };
  expect(classifyFailure(failure)).toBe(FAILURE_TYPES.SECRET_SCAN);
  expect(shouldEscalateImmediately(classifyFailure(failure))).toBe(true);
});

test('Phase 5 #1: timeout signal in reason or stderr beats failed_gate (loop-level timeout)', () => {
  // A loop-level timeout can fire before any gate; trust the timeout signal.
  expect(classifyFailure({ failed_gate: 'ralph-tests', reason: 'gate_timeout' })).toBe(FAILURE_TYPES.TIMEOUT);
  expect(classifyFailure({ failed_gate: 'ralph-tests', reason: '', stderr_preview: 'process timed out after 600s' })).toBe(FAILURE_TYPES.TIMEOUT);
  expect(classifyFailure({ failed_gate: 'ralph-tests', stderr_preview: 'ETIMEDOUT connecting to ...' })).toBe(FAILURE_TYPES.TIMEOUT);
});

test('Phase 5 #1: empty failure object classifies as UNKNOWN (not silently as some category)', () => {
  expect(classifyFailure({})).toBe(FAILURE_TYPES.UNKNOWN);
  expect(classifyFailure(undefined)).toBe(FAILURE_TYPES.UNKNOWN);
});
