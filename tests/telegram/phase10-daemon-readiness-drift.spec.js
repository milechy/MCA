const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const PHASE10 = path.join(process.cwd(), 'docs', 'telegram-phase10-unattended-daemon-readiness.md');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('Phase 10 daemon readiness preserves required preflight controls', () => {
  const doc = read(PHASE10);

  expect(doc).toContain('single instance guard');
  expect(doc).toContain('lock file ownership');
  expect(doc).toContain('health check');
  expect(doc).toContain('panic shutdown');
  expect(doc).toContain('rate limit');
  expect(doc).toContain('bounded polling');
  expect(doc).toContain('safe startup preflight');
  expect(doc).toContain('safe shutdown cleanup');
});

test('Phase 10 preserves current execution boundary and does not expand allowlist', () => {
  const doc = read(PHASE10);

  expect(doc).toContain('The only allowed executable command remains:');
  expect(doc).toContain('scripts/gates/run-all.sh');
  expect(doc).toContain('commands_executed contains only scripts/gates/run-all.sh');
  expect(doc).toContain('all execution still requires approval/hash/diff/allowlist preflight');
});

test('Phase 10 keeps OpenCode disabled and defines phased introduction only after readiness', () => {
  const doc = read(PHASE10);

  expect(doc).toContain('OpenCode remains disabled in Phase 10.');
  expect(doc).toContain('Phase 11: OpenCode dry-run bridge');
  expect(doc).toContain('forbidden: file modification, command execution, commit, push, deploy, migration');
  expect(doc).toContain('Phase 12: OpenCode local sandbox execution');
  expect(doc).toContain('Phase 13: approved OpenCode patch apply');
});

test('Phase 10 preserves explicit non-goals for daemon and OpenCode execution', () => {
  const doc = read(PHASE10);

  expect(doc).toContain('No unattended bot daemon start');
  expect(doc).toContain('No OpenCode execution from Telegram');
  expect(doc).toContain('No production deploy from Telegram');
  expect(doc).toContain('No database migration from Telegram');
  expect(doc).toContain('No CI Telegram Bot API execution');
  expect(doc).toContain('No persistent bot token in repository or CI');
  expect(doc).toContain('No persistent RALPH_TELEGRAM_RUN_ALL_ENABLED=true');
  expect(doc).toContain('No shell allowlist expansion');
  expect(doc).toContain('No automatic code modification');
});
