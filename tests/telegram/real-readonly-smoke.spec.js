const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MAX_RESPONSE_PREVIEW_CHARS,
  parseList,
  assertReadOnlyCommands,
  makeUpdate,
  responseKind,
  safeResponsePreview,
  summarizeSmokeResponse,
  runRealReadOnlySmoke
} = require('../../scripts/telegram/real-readonly-smoke');

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

test('response preview is one-line bounded and response kind is classified', () => {
  expect(responseKind('/ping', 'pong')).toBe('pong');
  expect(responseKind('/status', 'Status:\n```json\n{}\n```')).toBe('status');
  expect(responseKind('/policy', 'Execution policy:\n```json\n{}\n```')).toBe('policy');
  expect(responseKind('/policy', 'something else')).toBe('unexpected');

  const preview = safeResponsePreview(`hello\n${'x'.repeat(MAX_RESPONSE_PREVIEW_CHARS + 20)}`);
  expect(preview.length).toBe(MAX_RESPONSE_PREVIEW_CHARS + 1);
  expect(preview.endsWith('…')).toBe(true);
  expect(preview).not.toContain('\n');
});

test('summarizeSmokeResponse omits raw response payload while retaining bounded metadata', () => {
  const summary = summarizeSmokeResponse('/policy', {
    ok: true,
    reason: null,
    response_text: `Execution policy:\n${'x'.repeat(300)}`
  });

  expect(summary).toEqual({
    command: '/policy',
    ok: true,
    reason: null,
    response_kind: 'policy',
    response_preview: `Execution policy: ${'x'.repeat(MAX_RESPONSE_PREVIEW_CHARS - 'Execution policy: '.length)}…`,
    response_length: 318
  });
  expect(summary).not.toHaveProperty('response_text');
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
  expect(result.output_contract).toEqual({
    no_raw_update: true,
    no_raw_response_payload: true,
    no_private_ids: true,
    response_preview_max_chars: MAX_RESPONSE_PREVIEW_CHARS
  });
  expect(result.guard).toMatchObject({
    ok: true,
    stage: 'real_transport_read_only_guard',
    run_all_enabled: false,
    telegram_env_ok: true,
    repo_secret_preflight_ok: true,
    findings_count: 0
  });
  expect(result.results.map((entry) => entry.command)).toEqual(['/ping', '/status', '/policy']);
  expect(result.results.every((entry) => entry.ok === true)).toBe(true);
  expect(result.results.map((entry) => entry.response_kind)).toEqual(['pong', 'status', 'policy']);
});

test('real read-only smoke output does not leak token, raw ids, raw update, or raw response_text', async () => {
  const result = await runRealReadOnlySmoke({
    rootDir: makeTempRoot(),
    env: SAFE_ENV,
    dryRunTelegramSend: true
  });

  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(SAFE_ENV.TELEGRAM_BOT_TOKEN);
  expect(serialized).not.toContain('"TELEGRAM_BOT_TOKEN"');
  expect(serialized).not.toContain('"TELEGRAM_ALLOWED_USER_IDS"');
  expect(serialized).not.toContain('"TELEGRAM_ALLOWED_CHAT_IDS"');
  expect(serialized).not.toContain('"user_id"');
  expect(serialized).not.toContain('"chat_id"');
  expect(serialized).not.toContain('"from"');
  expect(serialized).not.toContain('"chat"');
  expect(serialized).not.toContain('"response_text"');
  expect(serialized).not.toContain('1234567890:ABCDEF_session_only_token');
  expect(result.results.every((entry) => entry.response_preview.length <= MAX_RESPONSE_PREVIEW_CHARS + 1)).toBe(true);
});

test('real read-only smoke fails closed when guard fails without exposing guard finding details', async () => {
  const result = await runRealReadOnlySmoke({
    rootDir: makeTempRoot(),
    env: { ...SAFE_ENV, RALPH_TELEGRAM_RUN_ALL_ENABLED: 'true' },
    dryRunTelegramSend: true
  });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('real_transport_guard_failed');
  expect(result.results).toEqual([]);
  expect(result.guard).toMatchObject({
    ok: false,
    stage: 'real_transport_read_only_guard',
    run_all_enabled: true,
    telegram_env_ok: true,
    repo_secret_preflight_ok: true,
    findings_count: 1
  });
  expect(result.guard).not.toHaveProperty('findings');
});

test('real read-only smoke fails at guard when ids are malformed', async () => {
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
  expect(result.reason).toBe('real_transport_guard_failed');
  expect(result.guard).toMatchObject({
    ok: false,
    stage: 'real_transport_read_only_guard',
    telegram_env_ok: false
  });
  expect(result.results).toEqual([]);
});
