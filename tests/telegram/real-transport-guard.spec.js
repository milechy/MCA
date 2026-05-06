const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { READ_ONLY_COMMANDS, realTransportGuard } = require('../../scripts/telegram/real-transport-guard');

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-real-transport-guard-'));
}

function writeFile(rootDir, relativePath, content) {
  const filePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

const SAFE_ENV = Object.freeze({
  TELEGRAM_BOT_TOKEN: '1234567890:ABCDEF_session_only_token',
  TELEGRAM_ALLOWED_USER_IDS: '123456789',
  TELEGRAM_ALLOWED_CHAT_IDS: '-1001234567890',
  RALPH_TELEGRAM_RUN_ALL_ENABLED: ''
});

test('real transport guard allows read-only smoke when env is session-only and run-all gate is off', () => {
  const result = realTransportGuard({
    rootDir: makeTempRoot(),
    env: SAFE_ENV,
    includeGitDiff: false
  });

  expect(result).toMatchObject({
    ok: true,
    stage: 'real_transport_read_only_guard',
    allowed_commands: READ_ONLY_COMMANDS,
    forbidden_commands: ['/run-all', '/approve', '/deny', '/modify', '/mode fullauto', '/confirm'],
    run_all_enabled: false,
    telegram_env_ok: true,
    token_redacted: '1234…oken',
    repo_secret_preflight_ok: true,
    findings: []
  });
});

test('real transport guard blocks missing Telegram transport env', () => {
  const result = realTransportGuard({
    rootDir: makeTempRoot(),
    env: {},
    includeGitDiff: false
  });

  expect(result.ok).toBe(false);
  expect(result.telegram_env_ok).toBe(false);
  expect(result.findings).toContainEqual({
    rule_id: 'telegram_transport_env_missing',
    detail: 'TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, and TELEGRAM_ALLOWED_CHAT_IDS must be set in the active shell session.'
  });
});

test('real transport guard blocks real run-all gate during read-only transport smoke', () => {
  const result = realTransportGuard({
    rootDir: makeTempRoot(),
    env: { ...SAFE_ENV, RALPH_TELEGRAM_RUN_ALL_ENABLED: 'true' },
    includeGitDiff: false
  });

  expect(result.ok).toBe(false);
  expect(result.run_all_enabled).toBe(true);
  expect(result.findings).toContainEqual({
    rule_id: 'real_run_all_gate_must_be_off_for_transport_smoke',
    detail: 'Unset RALPH_TELEGRAM_RUN_ALL_ENABLED before real Bot API read-only transport smoke.'
  });
});

test('real transport guard blocks repository or diff secret preflight findings', () => {
  const rootDir = makeTempRoot();
  writeFile(rootDir, '.env', 'RALPH_TELEGRAM_RUN_ALL_ENABLED=true\n');

  const result = realTransportGuard({
    rootDir,
    env: SAFE_ENV,
    includeGitDiff: false
  });

  expect(result.ok).toBe(false);
  expect(result.repo_secret_preflight_ok).toBe(false);
  expect(result.findings).toEqual([
    {
      rule_id: 'repo_or_diff_secret_preflight_failed',
      detail: '.env:1:persistent_run_all_gate_env_true'
    }
  ]);
});
