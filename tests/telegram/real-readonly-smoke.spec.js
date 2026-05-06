const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseList, assertReadOnlyCommands, makeUpdate, runRealReadOnlySmoke } = require('../../scripts/telegram/real-readonly-smoke');

function makeTempRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-real-readonly-smoke-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'logs', 'audit.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(rootDir, '.ralph', 'logs', 'execution.jsonl'), '', 'utf8');
  return rootDir;
}

const SAFE_ENV = Object.freeze({
  TELEGRAM_BOT_TOKEN: '1234567890:ABCDEF_session_only_token',
  TELEGRAM_ALLOWED_USER_IDS: '3',
  TELEGRAM_ALLOWED_CHAT_IDS: '10',
  RALPH_TELEGRAM_RUN_ALL_ENABLED: ''
});

test('parseList parses comma-separated Telegram ids', () => {
  expect(parseList('1, 2, -1003, nope')).toEqual([1, 2, -1003]);
  expect(parseList('')).toEqual([]);
  expect(parseList(null)).toEqual([]);
});

test('assertReadOnlyCommands allows only ping status and policy', () => {
  expect(() => assertReadOnlyCommands(['/ping', '/status', '/policy'])).not.toThrow();
  expect(() => assertReadOnlyCommands(['/ping', '/run-all APR .ralph/tmp/p.json'])).toThrow('real_readonly_smoke_disallowed_commands:/run-all APR .ralph/tmp/p.json');
});

test('makeUpdate creates Telegram-shaped update without private data', () => {
  expect(makeUpdate('/ping', { userId: 3, chatId: 10, updateId: 123 })).toEqual({
    update_id: 123,
    message: {
      text: '/ping',
      from: { id: 3 },
      chat: { id: 10 }
    }
  });
});

test('real read-only smoke runs only allowed commands in dry-send mode after guard passes', async () => {
  const result = await runRealReadOnlySmoke({
    rootDir: makeTempRoot(),
    env: SAFE_ENV,
    dryRunTelegramSend: true
  });

  expect(result.ok).toBe(true);
  expect(result.dry_run_telegram_send).toBe(true);
  expect(result.commands).toEqual(['/ping', '/status', '/policy']);
  expect(result.guard).toMatchObject({
    ok: true,
    stage: 'real_transport_read_only_guard',
    run_all_enabled: false,
    telegram_env_ok: true,
    repo_secret_preflight_ok: true
  });
  expect(result.results.map((entry) => entry.command)).toEqual(['/ping', '/status', '/policy']);
  expect(result.results.every((entry) => entry.ok === true)).toBe(true);
});

test('real read-only smoke fails closed when guard fails', async () => {
  const result = await runRealReadOnlySmoke({
    rootDir: makeTempRoot(),
    env: { ...SAFE_ENV, RALPH_TELEGRAM_RUN_ALL_ENABLED: 'true' },
    dryRunTelegramSend: true
  });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('real_transport_guard_failed');
  expect(result.results).toEqual([]);
  expect(result.guard.findings).toContainEqual({
    rule_id: 'real_run_all_gate_must_be_off_for_transport_smoke',
    detail: 'Unset RALPH_TELEGRAM_RUN_ALL_ENABLED before real Bot API read-only transport smoke.'
  });
});

test('real read-only smoke fails before runtime when ids cannot be parsed', async () => {
  const result = await runRealReadOnlySmoke({
    rootDir: makeTempRoot(),
    env: {
      TELEGRAM_BOT_TOKEN: '1234567890:ABCDEF_session_only_token',
      TELEGRAM_ALLOWED_USER_IDS: 'not-a-number',
      TELEGRAM_ALLOWED_CHAT_IDS: 'also-not-a-number',
      RALPH_TELEGRAM_RUN_ALL_ENABLED: ''
    },
    dryRunTelegramSend: true
  });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('telegram_ids_parse_failed');
  expect(result.results).toEqual([]);
});
