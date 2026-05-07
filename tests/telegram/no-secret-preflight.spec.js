const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { shouldScanFile, scanText, scanFiles, preflightNoSecrets } = require('../../scripts/telegram/preflight-no-secrets');

const TOKEN_LIKE = ['1234567890', 'ABCDEF', 'secret', 'token'].join('_').replace('_ABCDEF_', ':ABCDEF_');

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-no-secret-preflight-'));
}

function writeFile(rootDir, relativePath, content) {
  const filePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

test('scanText allows placeholders and shell variable references', () => {
  const findings = scanText({
    source: 'template.md',
    text: [
      'TELEGRAM_BOT_TOKEN="<private bot token>"',
      'TELEGRAM_BOT_TOKEN=<private value, never commit>',
      'TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN"',
      'RALPH_TELEGRAM_RUN_ALL_ENABLED=""'
    ].join('\n')
  });

  expect(findings).toEqual([]);
});

test('scanText detects token-like and persistent Telegram assignments', () => {
  const findings = scanText({
    source: '.env',
    text: [
      `TELEGRAM_BOT_TOKEN=${TOKEN_LIKE}`,
      'TELEGRAM_ALLOWED_USER_IDS=123456789',
      'TELEGRAM_ALLOWED_CHAT_IDS=-1001234567890',
      'RALPH_TELEGRAM_RUN_ALL_ENABLED=true'
    ].join('\n')
  });

  expect(findings.map((finding) => finding.rule_id)).toEqual([
    'telegram_bot_token_assignment',
    'telegram_allowed_user_ids_assignment',
    'telegram_allowed_chat_ids_assignment',
    'persistent_run_all_gate_env_true'
  ]);
});

test('scanText detects persistent YAML run-all gate and GitHub token secret references', () => {
  const findings = scanText({
    source: '.github/workflows/unsafe.yml',
    text: [
      'RALPH_TELEGRAM_RUN_ALL_ENABLED: "true"',
      'TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}'
    ].join('\n')
  });

  expect(findings.map((finding) => finding.rule_id)).toEqual([
    'persistent_run_all_gate_yaml_true',
    'github_secret_bot_token_reference'
  ]);
});

test('shouldScanFile limits repository scan to persistent config surfaces', () => {
  const rootDir = makeTempRoot();
  const envPath = writeFile(rootDir, '.env.local', '');
  const workflowPath = writeFile(rootDir, '.github/workflows/unsafe.yml', '');
  const docsPath = writeFile(rootDir, 'docs/template.md', '');
  const testPath = writeFile(rootDir, 'tests/telegram/fixture.spec.js', '');

  expect(shouldScanFile(rootDir, envPath)).toBe(true);
  expect(shouldScanFile(rootDir, workflowPath)).toBe(true);
  expect(shouldScanFile(rootDir, docsPath)).toBe(false);
  expect(shouldScanFile(rootDir, testPath)).toBe(false);
});

test('scanFiles scans persistent config surfaces and skips docs tests and node_modules', () => {
  const rootDir = makeTempRoot();
  writeFile(rootDir, 'docs/template.md', 'TELEGRAM_ALLOWED_USER_IDS=123456789\n');
  writeFile(rootDir, 'tests/telegram/fixture.spec.js', 'RALPH_TELEGRAM_RUN_ALL_ENABLED=true\n');
  writeFile(rootDir, '.env.local', 'TELEGRAM_ALLOWED_CHAT_IDS=-1001234567890\n');
  writeFile(rootDir, 'node_modules/pkg/index.js', `TELEGRAM_BOT_TOKEN=${TOKEN_LIKE}\n`);

  const findings = scanFiles(rootDir);

  expect(findings).toEqual([
    {
      source: '.env.local',
      line: 1,
      rule_id: 'telegram_allowed_chat_ids_assignment'
    }
  ]);
});

test('preflightNoSecrets passes safe templates and fails unsafe persistent config content', () => {
  const safeRoot = makeTempRoot();
  writeFile(safeRoot, 'docs/template.md', 'TELEGRAM_ALLOWED_USER_IDS=123456789\nRALPH_TELEGRAM_RUN_ALL_ENABLED=true\n');
  expect(preflightNoSecrets({ rootDir: safeRoot, includeGitDiff: false })).toEqual({ ok: true, findings: [] });

  const unsafeRoot = makeTempRoot();
  writeFile(unsafeRoot, '.env', `TELEGRAM_BOT_TOKEN=${TOKEN_LIKE}\n`);
  const result = preflightNoSecrets({ rootDir: unsafeRoot, includeGitDiff: false });
  expect(result.ok).toBe(false);
  expect(result.findings).toEqual([
    {
      source: '.env',
      line: 1,
      rule_id: 'telegram_bot_token_assignment'
    }
  ]);
});
