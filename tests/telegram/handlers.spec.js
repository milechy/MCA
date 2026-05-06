const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseTelegramCommand } = require('../../src/telegram/command-parser');
const { handleTelegramCommand } = require('../../src/telegram/handlers');
const { processTelegramUpdate } = require('../../src/telegram/bot');
const { MODES, loadMode } = require('../../src/ralph/mode-manager');

function makeTempRoot(initialMode = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-handlers-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'logs', 'audit.jsonl'), '', 'utf8');
  fs.writeFileSync(
    path.join(rootDir, '.ralph', 'state.json'),
    `${JSON.stringify({
      loop_id: 'telegram-test',
      phase: 'IDLE',
      current_story_id: null,
      iteration: 0,
      consecutive_failures: 0,
      active_mode: 'approval',
      current_approval_id: null,
      last_green_commit: null,
      security_stop: false,
      updated_at: '2026-05-06T00:00:00+09:00'
    }, null, 2)}\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(rootDir, '.ralph', 'mode.json'),
    `${JSON.stringify({
      mode: MODES.APPROVAL,
      effective_until: null,
      auto_revert_to: null,
      changed_by: { channel: 'manual', user: 'test' },
      policy_version: 'approval-policy-v1.4',
      reason: 'telegram_test_setup',
      updated_at: '2026-05-06T00:00:00+09:00',
      ...initialMode
    }, null, 2)}\n`,
    'utf8'
  );
  return rootDir;
}

function roles() {
  return {
    owner_user_ids: [1],
    admin_user_ids: [2],
    reviewer_user_ids: [3],
    observer_user_ids: [4]
  };
}

function update(userId, chatId, text) {
  return {
    message: {
      text,
      from: { id: userId },
      chat: { id: chatId }
    }
  };
}

function allowedConfig() {
  return {
    allowed_user_ids: [1, 2, 3, 4],
    allowed_chat_ids: [10]
  };
}

test('/ping returns pong', () => {
  const result = handleTelegramCommand(parseTelegramCommand('/ping'), {
    rootDir: makeTempRoot(),
    user_id: 3,
    roles: roles()
  });

  expect(result.ok).toBe(true);
  expect(result.text).toBe('pong');
});

test('/status returns state and mode', () => {
  const rootDir = makeTempRoot();
  const result = handleTelegramCommand(parseTelegramCommand('/status'), {
    rootDir,
    user_id: 3,
    roles: roles()
  });

  expect(result.ok).toBe(true);
  expect(result.status.state.phase).toBe('IDLE');
  expect(result.status.mode.mode).toBe(MODES.APPROVAL);
  expect(result.text).toContain('Status:');
});

test('/policy returns read-only execution policy status', () => {
  const result = handleTelegramCommand(parseTelegramCommand('/policy'), {
    rootDir: makeTempRoot(),
    user_id: 3,
    roles: roles()
  });

  expect(result.ok).toBe(true);
  expect(result.wired_to_runtime).toBe(false);
  expect(result.policy.telegram_shell_execution_connected).toBe(false);
  expect(result.policy.allow_real_execution_required).toBe(true);
  expect(result.policy.allowed_commands[0]).toMatchObject({
    id: 'gates-run-all',
    command: 'scripts/gates/run-all.sh',
    allowed_args: [],
    allowed_cwd: '.',
    dry_run_only: false
  });
  expect(result.text).toContain('Execution policy:');
});

test('/mode fullauto creates token but does not immediately switch mode', () => {
  const rootDir = makeTempRoot();
  const result = handleTelegramCommand(parseTelegramCommand('/mode fullauto 6'), {
    rootDir,
    user_id: 2,
    roles: roles()
  });

  expect(result.ok).toBe(true);
  expect(result.result.ok).toBe(true);
  expect(result.result.token).toMatch(/^MODE-/);
  expect(result.text).toContain('/confirm');
  expect(loadMode(rootDir).mode).toBe(MODES.APPROVAL);
});

test('/confirm enables fullauto after a valid fullauto request', () => {
  const rootDir = makeTempRoot();
  const request = handleTelegramCommand(parseTelegramCommand('/mode fullauto 6'), {
    rootDir,
    user_id: 2,
    roles: roles()
  });

  const confirm = handleTelegramCommand(parseTelegramCommand(`/confirm ${request.result.token}`), {
    rootDir,
    user_id: 2,
    roles: roles()
  });

  expect(confirm.ok).toBe(true);
  expect(confirm.result.ok).toBe(true);
  expect(confirm.result.mode.mode).toBe(MODES.FULLAUTO);
  expect(loadMode(rootDir).mode).toBe(MODES.FULLAUTO);
});

test('/mode approval switches back to approval for reviewer', () => {
  const rootDir = makeTempRoot({
    mode: MODES.FULLAUTO,
    effective_until: new Date(Date.now() + 60_000).toISOString(),
    auto_revert_to: MODES.APPROVAL
  });

  const result = handleTelegramCommand(parseTelegramCommand('/mode approval'), {
    rootDir,
    user_id: 3,
    roles: roles()
  });

  expect(result.ok).toBe(true);
  expect(result.result.ok).toBe(true);
  expect(loadMode(rootDir).mode).toBe(MODES.APPROVAL);
});

test('/approve routes through adapter and remains execution-disconnected', () => {
  const result = handleTelegramCommand(parseTelegramCommand('/approve APR-001'), {
    rootDir: makeTempRoot(),
    user_id: 3,
    roles: roles()
  });

  expect(result.ok).toBe(true);
  expect(result.wired_to_runtime).toBe(false);
  expect(result.result.ok).toBe(false);
  expect(result.result.reason).toBe('approval_not_found');
  expect(result.text).toContain('Approve failed: approval_not_found');
});

test('processTelegramUpdate rejects unauthorized user or chat', async () => {
  const rootDir = makeTempRoot();
  const badUser = await processTelegramUpdate(update(999, 10, '/ping'), {
    rootDir,
    config: allowedConfig(),
    roles: roles()
  });
  const badChat = await processTelegramUpdate(update(3, 99, '/ping'), {
    rootDir,
    config: allowedConfig(),
    roles: roles()
  });

  expect(badUser.ok).toBe(false);
  expect(badUser.reason).toBe('telegram_user_not_allowed');
  expect(badChat.ok).toBe(false);
  expect(badChat.reason).toBe('telegram_chat_not_allowed');
});

test('processTelegramUpdate accepts authorized command', async () => {
  const result = await processTelegramUpdate(update(3, 10, '/ping'), {
    rootDir: makeTempRoot(),
    config: allowedConfig(),
    roles: roles()
  });

  expect(result.ok).toBe(true);
  expect(result.response_text).toBe('pong');
});
