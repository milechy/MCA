const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { sendMessage, handleUpdate } = require('../../src/telegram/runtime');

function makeTempRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-runtime-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'logs', 'audit.jsonl'), '', 'utf8');
  fs.writeFileSync(
    path.join(rootDir, '.ralph', 'state.json'),
    `${JSON.stringify({
      loop_id: 'telegram-runtime-test',
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
      mode: 'approval',
      effective_until: null,
      auto_revert_to: null,
      changed_by: { channel: 'manual', user: 'test' },
      policy_version: 'approval-policy-v1.4',
      reason: 'telegram_runtime_test_setup',
      updated_at: '2026-05-06T00:00:00+09:00'
    }, null, 2)}\n`,
    'utf8'
  );
  return rootDir;
}

function update(text = '/ping') {
  return {
    update_id: 1,
    message: {
      text,
      from: { id: 3 },
      chat: { id: 10 }
    }
  };
}

test('sendMessage does not call Telegram API in dry-run mode', async () => {
  const result = await sendMessage({ dry_run: true }, 10, 'pong');

  expect(result).toEqual({ dry_run: true, chat_id: 10, text: 'pong' });
});

test('handleUpdate processes authorized command and returns response text', async () => {
  const result = await handleUpdate(update('/ping'), {
    rootDir: makeTempRoot(),
    config: {
      dry_run: true,
      allowed_user_ids: [3],
      allowed_chat_ids: [10]
    },
    roles: {
      owner_user_ids: [1],
      admin_user_ids: [2],
      reviewer_user_ids: [3],
      observer_user_ids: [4]
    }
  });

  expect(result.ok).toBe(true);
  expect(result.response_text).toBe('pong');
});
