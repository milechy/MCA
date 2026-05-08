const { test, expect } = require('@playwright/test');

const { OPENCODE_CLI_ENV, DEFAULT_OPENCODE_CLI, DEFAULT_CANDIDATE_PATCH, normalizeCli, buildOpenCodeRunInvocation } = require('../../src/telegram/opencode-real-adapter');
const { commandIsAllowed } = require('../../src/telegram/opencode-run');

test('normalizeCli allows only simple non-shell CLI names', () => {
  expect(normalizeCli()).toBe(DEFAULT_OPENCODE_CLI);
  expect(normalizeCli('opencode')).toBe('opencode');
  expect(normalizeCli('opencode-cli')).toBe('opencode-cli');
  expect(normalizeCli('/usr/bin/opencode')).toBe(null);
  expect(normalizeCli('../opencode')).toBe(null);
  expect(normalizeCli('opencode;rm')).toBe(null);
});

test('buildOpenCodeRunInvocation builds real candidate patch invocation without apply permissions', () => {
  const result = buildOpenCodeRunInvocation({ task: 'add a focused test', env: { [OPENCODE_CLI_ENV]: 'opencode' } });
  expect(result).toMatchObject({
    ok: true,
    reason: null,
    command: 'opencode',
    args: ['run', '--diff-only', '--output', DEFAULT_CANDIDATE_PATCH, '--task', 'add a focused test'],
    candidate_patch_filename: DEFAULT_CANDIDATE_PATCH,
    repo_mutation_allowed: false,
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    deploy_allowed: false,
    migration_allowed: false
  });
  expect(commandIsAllowed(result.command, result.args)).toBe(true);
});

test('buildOpenCodeRunInvocation blocks missing task and unsafe CLI', () => {
  expect(buildOpenCodeRunInvocation({ task: '', env: { [OPENCODE_CLI_ENV]: 'opencode' } }).reason).toBe('task_required');
  expect(buildOpenCodeRunInvocation({ task: 'x', env: { [OPENCODE_CLI_ENV]: '../opencode' } }).reason).toBe('opencode_cli_not_allowed');
});
