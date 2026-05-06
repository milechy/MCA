const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW_PATH = path.join(process.cwd(), '.github', 'workflows', 'phase4-telegram-smoke.yml');

test('Phase 4 Telegram smoke workflow exists and runs only safe test commands', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  expect(workflow).toContain('name: Phase 4 Telegram Smoke Safety');
  expect(workflow).toContain('npm run telegram:ci-smoke');
  expect(workflow).toContain('npm run test:ralph');
  expect(workflow).toContain('npm run test:telegram');
});

test('Phase 4 Telegram smoke workflow keeps real Telegram execution disabled', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  expect(workflow).toContain('RALPH_TELEGRAM_RUN_ALL_ENABLED: ""');
  expect(workflow).not.toContain('RALPH_TELEGRAM_RUN_ALL_ENABLED: "true"');
  expect(workflow).not.toContain('TELEGRAM_BOT_TOKEN:');
  expect(workflow).not.toContain('secrets.TELEGRAM_BOT_TOKEN');
  expect(workflow).not.toContain('telegram:default-off-smoke');
  expect(workflow).not.toContain('scripts/gates/run-all.sh');
  expect(workflow).not.toContain('allow_real_execution');
});
