const { test, expect } = require('@playwright/test');
const {
  runLadder,
  summarizeLevel,
  levelGateSatisfied,
  parseArgs
} = require('../../scripts/ralph/live-validation-ladder');

test('ladder lists levels 0 through 5 with bounded JSON', () => {
  const result = runLadder({ level: null, json: true, assert_gate: false }, {});

  expect(result).toMatchObject({
    ok: true,
    stage: 'ralph_live_validation_ladder',
    version: 'ralph_live_validation_ladder_v0_1',
    execution_connected: false,
    repository_files_modified: [],
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    raw_logs_included: false,
    secrets_included: false,
    bounded_output: true,
    next_action: 'follow_ladder_one_level_at_a_time'
  });
  expect(result.levels.map((level) => level.level)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(JSON.stringify(result)).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
});

test('level 0 has no live gate and higher levels require explicit env gate', () => {
  expect(levelGateSatisfied(0, {})).toBe(true);
  expect(levelGateSatisfied(1, {})).toBe(false);
  expect(levelGateSatisfied(1, { RALPH_LIVE_VALIDATION_LEVEL: '1' })).toBe(true);
  expect(levelGateSatisfied(4, { RALPH_LIVE_VALIDATION_LEVEL: '3' })).toBe(false);
});

test('assert gate fails when requested live level env is not set', () => {
  const result = runLadder({ level: 4, json: true, assert_gate: true }, {});

  expect(result).toMatchObject({
    ok: false,
    reason: 'required_live_validation_gate_not_set',
    next_action: 'set_explicit_live_validation_gate_or_lower_level'
  });
  expect(result.levels[0]).toMatchObject({
    level: 4,
    name: 'live_pr_sandbox_no_merge',
    gate_satisfied: false
  });
});

test('assert gate passes for explicitly gated level', () => {
  const result = runLadder(
    { level: 3, json: true, assert_gate: true },
    { RALPH_LIVE_VALIDATION_LEVEL: '3' }
  );

  expect(result).toMatchObject({
    ok: true,
    reason: null,
    next_action: 'follow_ladder_one_level_at_a_time'
  });
  expect(result.levels[0]).toMatchObject({
    level: 3,
    gate_satisfied: true,
    name: 'live_push_test_branch_no_pr'
  });
});

test('parseArgs supports level json and assert-gate', () => {
  expect(parseArgs(['--level', '2', '--json', '--assert-gate'])).toEqual({
    level: 2,
    json: true,
    assert_gate: true
  });
});

test('summarizeLevel returns null for unknown level', () => {
  expect(summarizeLevel(99, {})).toBe(null);
});
