const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const OPERATOR_RUNBOOK = path.join(process.cwd(), 'docs', 'telegram-bot-operator-runbook.md');
const PHASE9_CONTROLS = path.join(process.cwd(), 'docs', 'telegram-phase9-observability-incident-controls.md');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('Phase 9 observability controls preserve bounded report surfaces and forbidden raw payloads', () => {
  const controls = read(PHASE9_CONTROLS);

  expect(controls).toContain('bounded log summaries');
  expect(controls).toContain('incident trigger conditions');
  expect(controls).toContain('safe report validation');
  expect(controls).toContain('npm run telegram:inspect-logs');
  expect(controls).toContain('npm run telegram:validate-smoke-report -- <report-file>');
  expect(controls).toContain('stdout from shell execution');
  expect(controls).toContain('stderr from shell execution');
  expect(controls).toContain('raw update payload');
  expect(controls).toContain('raw response payload');
  expect(controls).toContain('full audit log');
  expect(controls).toContain('full execution log');
});

test('Phase 9 incident controls preserve trigger conditions and evidence preservation', () => {
  const controls = read(PHASE9_CONTROLS);

  expect(controls).toContain('unauthorized user/chat reaches shell execution');
  expect(controls).toContain('unknown command reaches shell execution');
  expect(controls).toContain('unsafe plan path reaches shell execution');
  expect(controls).toContain('/run-all executes while RALPH_TELEGRAM_RUN_ALL_ENABLED is unset or not exactly true');
  expect(controls).toContain('command other than scripts/gates/run-all.sh executes');
  expect(controls).toContain('commands_executed contains more than one command');
  expect(controls).toContain('files_modified is non-empty');
  expect(controls).toContain('cp .ralph/logs/audit.jsonl .ralph/logs/audit.incident.$(date +%Y%m%d%H%M%S).jsonl');
  expect(controls).toContain('cp .ralph/logs/execution.jsonl .ralph/logs/execution.incident.$(date +%Y%m%d%H%M%S).jsonl');
  expect(controls).toContain('cp .ralph/approval-log.jsonl .ralph/approval-log.incident.$(date +%Y%m%d%H%M%S).jsonl');
});

test('Phase 9 preserves explicit non-goals and does not expand Telegram execution scope', () => {
  const controls = read(PHASE9_CONTROLS);

  expect(controls).toContain('The only allowed executable command remains:');
  expect(controls).toContain('scripts/gates/run-all.sh');
  expect(controls).toContain('No unattended bot daemon rollout');
  expect(controls).toContain('No production deploy from Telegram');
  expect(controls).toContain('No database migration from Telegram');
  expect(controls).toContain('No OpenCode execution from Telegram');
  expect(controls).toContain('No CI Telegram Bot API execution');
  expect(controls).toContain('No persistent bot token in repository or CI');
  expect(controls).toContain('No persistent RALPH_TELEGRAM_RUN_ALL_ENABLED=true');
  expect(controls).toContain('No shell allowlist expansion');
});

test('operator runbook links Phase 9 observability controls and preserves incident abort actions', () => {
  const runbook = read(OPERATOR_RUNBOOK);

  expect(runbook).toContain('## Phase 9 observability and incident controls');
  expect(runbook).toContain('docs/telegram-phase9-observability-incident-controls.md');
  expect(runbook).toContain('npm run telegram:validate-smoke-report -- <report-file>');
  expect(runbook).toContain('unknown command reaches shell execution');
  expect(runbook).toContain('`commands_executed` contains more than one command');
  expect(runbook).toContain('working tree remains dirty after cleanup');
  expect(runbook).toContain('cp .ralph/approval-log.jsonl .ralph/approval-log.incident.$(date +%Y%m%d%H%M%S).jsonl');
  expect(runbook).toContain('post preserved incident logs to chat unless separately redacted and validated');
});
