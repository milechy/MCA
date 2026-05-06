const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_SCRIPTS = Object.freeze({
  'telegram:check-env': 'node scripts/telegram/check-env.js',
  'telegram:inspect-logs': 'node scripts/telegram/inspect-logs.js',
  'telegram:preflight-no-secrets': 'node scripts/telegram/preflight-no-secrets.js',
  'telegram:default-off-smoke': 'node scripts/telegram/default-off-smoke.js',
  'telegram:dry-transport-smoke': 'node scripts/telegram/dry-transport-smoke.js',
  'telegram:ci-smoke': 'npm run telegram:preflight-no-secrets && npm run telegram:check-env --if-present && npm run telegram:dry-transport-smoke && npm run telegram:inspect-logs --if-present'
});

test('package.json exposes CI-safe Telegram smoke helper scripts', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));

  for (const [name, command] of Object.entries(REQUIRED_SCRIPTS)) {
    expect(packageJson.scripts[name]).toBe(command);
  }
});

test('Telegram smoke npm scripts do not enable real run-all execution by themselves', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));

  for (const name of Object.keys(REQUIRED_SCRIPTS)) {
    expect(packageJson.scripts[name]).not.toContain('RALPH_TELEGRAM_RUN_ALL_ENABLED=true');
    expect(packageJson.scripts[name]).not.toContain('allow_real_execution');
    expect(packageJson.scripts[name]).not.toContain('scripts/gates/run-all.sh');
  }
});
