const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const OPERATOR_RUNBOOK = path.join(process.cwd(), 'docs', 'telegram-bot-operator-runbook.md');
const PHASE4_SMOKE_PLAN = path.join(process.cwd(), 'docs', 'telegram-bot-phase4-smoke.md');
const PHASE3_CHECKLIST = path.join(process.cwd(), 'docs', 'telegram-run-all-phase3-checklist.md');
const PHASE4_CHECKLIST = path.join(process.cwd(), 'docs', 'telegram-phase4-completion-checklist.md');
const PHASE5_TEMPLATE = path.join(process.cwd(), 'docs', 'telegram-phase5-manual-smoke-template.md');
const PHASE5_GO_NO_GO = path.join(process.cwd(), 'docs', 'telegram-phase5-readonly-go-no-go.md');
const PHASE5_CHECKLIST = path.join(process.cwd(), 'docs', 'telegram-phase5-completion-checklist.md');

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

test('Phase 4 completion checklist preserves CI-safe and manual-smoke boundaries', () => {
  const checklist = read(PHASE4_CHECKLIST);

  expect(checklist).toContain('## Current safe CI boundary');
  expect(checklist).toContain('CI must not set:');
  expect(checklist).toContain('RALPH_TELEGRAM_RUN_ALL_ENABLED=true');
  expect(checklist).toContain('CI must not reference:');
  expect(checklist).toContain('secrets.TELEGRAM_BOT_TOKEN');
  expect(checklist).toContain('## Manual smoke readiness');
  expect(checklist).toContain('The operator has read `docs/telegram-bot-operator-runbook.md`.');
  expect(checklist).toContain('## Deferred to Phase 5+');
  expect(checklist).toContain('CI job that performs real gated `/run-all`');
});

test('Phase 4 completion checklist preserves permanent safety invariant', () => {
  const checklist = read(PHASE4_CHECKLIST);

  expect(checklist).toContain('## Safety invariant');
  expect(checklist).toContain('No repository, CI workflow, npm script, or document should make real Telegram `/run-all` execution persistent or automatic.');
  expect(checklist).toContain('export RALPH_TELEGRAM_RUN_ALL_ENABLED=true');
  expect(checklist).toContain('authorization, approval, hash, command allowlist, and shell execution policy gates');
});

test('Phase 5 manual smoke template preserves secret-safe handoff boundary', () => {
  const template = read(PHASE5_TEMPLATE);

  expect(template).toContain('Do **not** fill this file with real secrets, Telegram user ids, chat ids, bot tokens, or private URLs.');
  expect(template).toContain('Keep these values outside the repository:');
  expect(template).toContain('TELEGRAM_BOT_TOKEN=<private value, never commit>');
  expect(template).toContain('git diff --cached');
  expect(template).toContain('Do not include token values, Telegram user ids, chat ids, private bot URLs, or raw log payloads containing private values.');
});

test('Phase 5 manual smoke template preserves guarded real read-only smoke flow', () => {
  const template = read(PHASE5_TEMPLATE);

  expect(template).toContain('npm run telegram:real-transport-guard');
  expect(template).toContain('npm run telegram:real-readonly-smoke');
  expect(template).toContain('allowed_commands=["/ping","/status","/policy"]');
  expect(template).toContain('forbidden_commands includes /run-all, /approve, /deny, /modify, /mode fullauto, /confirm');
  expect(template).toContain('If this command fails, do not run real Bot API smoke.');
  expect(template).toContain('This runner is intentionally limited to:');
});

test('Phase 5 manual smoke template preserves default-off and explicit-gate sequence', () => {
  const template = read(PHASE5_TEMPLATE);

  expect(template).toContain('unset RALPH_TELEGRAM_RUN_ALL_ENABLED');
  expect(template).toContain('telegram_run_all_enabled=false');
  expect(template).toContain('READY_BUT_NOT_EXECUTED');
  expect(template).toContain('This stage is manual only and must not be run by `telegram:real-readonly-smoke`.');
  expect(template).toContain('Only proceed after stages 1-3 pass and after separate operator confirmation.');
  expect(template).toContain('export RALPH_TELEGRAM_RUN_ALL_ENABLED=true');
  expect(template).toContain('Run-all execution completed.');
});

test('Phase 5 read-only go/no-go checklist preserves hard no-go and allowed command boundaries', () => {
  const checklist = read(PHASE5_GO_NO_GO);

  expect(checklist).toContain('It does not authorize real `/run-all` execution.');
  expect(checklist).toContain('/ping\n/status\n/policy');
  expect(checklist).toContain('/run-all\n/approve\n/deny\n/modify\n/mode fullauto\n/confirm');
  expect(checklist).toContain('## Hard no-go conditions');
  expect(checklist).toContain('`RALPH_TELEGRAM_RUN_ALL_ENABLED=true` is set');
  expect(checklist).toContain('`npm run telegram:real-transport-guard` fails');
});

test('Phase 5 read-only go/no-go checklist preserves output redaction contract and deferred items', () => {
  const checklist = read(PHASE5_GO_NO_GO);

  expect(checklist).toContain('output_contract.no_raw_update=true');
  expect(checklist).toContain('output_contract.no_raw_response_payload=true');
  expect(checklist).toContain('output_contract.no_private_ids=true');
  expect(checklist).toContain('raw user id');
  expect(checklist).toContain('raw chat id');
  expect(checklist).toContain('raw response_text');
  expect(checklist).toContain('## Deferred items');
  expect(checklist).toContain('real default-off `/run-all` smoke');
  expect(checklist).toContain('CI job that performs gated `/run-all`');
});

test('Phase 5 completion checklist preserves current command boundaries and manual-only real smoke', () => {
  const checklist = read(PHASE5_CHECKLIST);

  expect(checklist).toContain('manual real-smoke template with secrets-safe handoff');
  expect(checklist).toContain('real read-only smoke runner skeleton');
  expect(checklist).toContain('Manual-only commands requiring operator judgment:');
  expect(checklist).toContain('npm run telegram:real-transport-guard');
  expect(checklist).toContain('npm run telegram:real-readonly-smoke');
  expect(checklist).toContain('`telegram:real-readonly-smoke` must remain manual-only');
});

test('Phase 5 completion checklist preserves CI disconnection and hard deferred items', () => {
  const checklist = read(PHASE5_CHECKLIST);

  expect(checklist).toContain('CI must not use:');
  expect(checklist).toContain('secrets.TELEGRAM_BOT_TOKEN');
  expect(checklist).toContain('telegram:real-readonly-smoke');
  expect(checklist).toContain('CI must not perform real Telegram Bot API calls or real `/run-all` execution.');
  expect(checklist).toContain('## Hard deferred items');
  expect(checklist).toContain('explicit-gate real `/run-all` smoke');
  expect(checklist).toContain('CI job that calls Telegram Bot API');
  expect(checklist).toContain('production deploys from Telegram');
});

test('Telegram docs do not instruct CI or repository-persistent real run-all enablement', () => {
  const docs = [
    read(OPERATOR_RUNBOOK),
    read(PHASE4_SMOKE_PLAN),
    read(PHASE3_CHECKLIST),
    read(PHASE4_CHECKLIST),
    read(PHASE5_TEMPLATE),
    read(PHASE5_GO_NO_GO),
    read(PHASE5_CHECKLIST)
  ].join('\n');

  expect(docs).not.toContain('secrets.RALPH_TELEGRAM_RUN_ALL_ENABLED');
  expect(docs).not.toContain('RALPH_TELEGRAM_RUN_ALL_ENABLED: "true"');
  expect(docs).not.toContain('echo RALPH_TELEGRAM_RUN_ALL_ENABLED=true >>');
  expect(docs).not.toContain('git add .env');
  expect(docs).not.toContain('git add .ralph/logs');
});
