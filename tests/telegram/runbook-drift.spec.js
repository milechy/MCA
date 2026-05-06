const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const OPERATOR_RUNBOOK = path.join(process.cwd(), 'docs', 'telegram-bot-operator-runbook.md');
const PHASE4_SMOKE_PLAN = path.join(process.cwd(), 'docs', 'telegram-bot-phase4-smoke.md');
const PHASE3_CHECKLIST = path.join(process.cwd(), 'docs', 'telegram-run-all-phase3-checklist.md');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('operator runbook preserves default-off and explicit gate safety instructions', () => {
  const runbook = read(OPERATOR_RUNBOOK);

  expect(runbook).toContain('unset RALPH_TELEGRAM_RUN_ALL_ENABLED');
  expect(runbook).toContain('export RALPH_TELEGRAM_RUN_ALL_ENABLED=true');
  expect(runbook).toContain('Never set this variable globally in a shell profile, CI environment, shared terminal session, or repository file.');
  expect(runbook).toContain('Only enter this stage after Stages 1-3 pass.');
  expect(runbook).toContain('Disable real run-all execution');
});

test('operator runbook preserves abort criteria and log preservation steps', () => {
  const runbook = read(OPERATOR_RUNBOOK);

  expect(runbook).toContain('## Immediate abort criteria');
  expect(runbook).toContain('unauthorized user/chat reaches execution');
  expect(runbook).toContain('unsafe `/run-all` path reaches execution');
  expect(runbook).toContain('`/run-all` executes while `RALPH_TELEGRAM_RUN_ALL_ENABLED` is unset or not exactly `true`');
  expect(runbook).toContain('cp .ralph/logs/audit.jsonl .ralph/logs/audit.abort.$(date +%Y%m%d%H%M%S).jsonl');
  expect(runbook).toContain('cp .ralph/logs/execution.jsonl .ralph/logs/execution.abort.$(date +%Y%m%d%H%M%S).jsonl');
  expect(runbook).toContain('Do not delete preserved abort copies.');
});

test('operator runbook preserves secret handling and no-go safety boundaries', () => {
  const runbook = read(OPERATOR_RUNBOOK);

  expect(runbook).toContain('unset TELEGRAM_BOT_TOKEN');
  expect(runbook).toContain('unset TELEGRAM_ALLOWED_USER_IDS');
  expect(runbook).toContain('unset TELEGRAM_ALLOWED_CHAT_IDS');
  expect(runbook).toContain('Do not:');
  expect(runbook).toContain('commit bot tokens or Telegram IDs to the repository');
  expect(runbook).toContain('set `RALPH_TELEGRAM_RUN_ALL_ENABLED=true` in GitHub Actions');
  expect(runbook).toContain('allow production deploys or migrations from Telegram');
  expect(runbook).toContain('bypass approval/hash/diff preflight');
});

test('Phase 4 smoke plan preserves non-goals and CI deferred items', () => {
  const smokePlan = read(PHASE4_SMOKE_PLAN);

  expect(smokePlan).toContain('## Non-goals');
  expect(smokePlan).toContain('Phase 4 smoke does not authorize arbitrary shell execution, deploys, production migrations, production secrets, or OpenCode execution from Telegram.');
  expect(smokePlan).toContain('## CI deferred items');
  expect(smokePlan).toContain('secret storage for `TELEGRAM_BOT_TOKEN`');
  expect(smokePlan).toContain('explicit protection against running real `/run-all` on pull request forks');
  expect(smokePlan).toContain('incident-response runbook');
});

test('Phase 3 checklist preserves execution model and deferred production boundaries', () => {
  const checklist = read(PHASE3_CHECKLIST);

  expect(checklist).toContain('Telegram `/run-all` is default-off.');
  expect(checklist).toContain('`RALPH_TELEGRAM_RUN_ALL_ENABLED=true` is explicitly set.');
  expect(checklist).toContain('If the environment gate is absent or not exactly `true`, `/run-all` remains preflight-only');
  expect(checklist).toContain('production deploy/migration execution from Telegram');
  expect(checklist).toContain('OpenCode runtime execution from Telegram');
  expect(checklist).toContain('multi-command allowlist expansion');
});

test('Telegram docs do not instruct CI or repository-persistent real run-all enablement', () => {
  const docs = [read(OPERATOR_RUNBOOK), read(PHASE4_SMOKE_PLAN), read(PHASE3_CHECKLIST)].join('\n');

  expect(docs).not.toContain('secrets.RALPH_TELEGRAM_RUN_ALL_ENABLED');
  expect(docs).not.toContain('RALPH_TELEGRAM_RUN_ALL_ENABLED: "true"');
  expect(docs).not.toContain('echo RALPH_TELEGRAM_RUN_ALL_ENABLED=true >>');
  expect(docs).not.toContain('git add .env');
  expect(docs).not.toContain('git add .ralph/logs');
});
