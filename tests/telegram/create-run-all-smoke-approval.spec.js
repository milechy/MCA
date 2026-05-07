const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  nowStamp,
  firstAllowedUserId,
  makeSmokePlan,
  createRunAllSmokeApproval
} = require('../../scripts/telegram/create-run-all-smoke-approval');

function makeTempRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-run-all-smoke-approval-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'approval-log.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(rootDir, '.ralph', 'logs', 'audit.jsonl'), '', 'utf8');
  return rootDir;
}

const SAFE_ENV = Object.freeze({
  TELEGRAM_BOT_TOKEN: '1234567890:ABCDEF_session_only_token',
  TELEGRAM_ALLOWED_USER_IDS: '3,4',
  TELEGRAM_ALLOWED_CHAT_IDS: '10',
  RALPH_TELEGRAM_RUN_ALL_ENABLED: ''
});

test('nowStamp produces compact deterministic timestamp for explicit date', () => {
  expect(nowStamp(new Date('2026-05-07T01:02:03.456Z'))).toBe('20260507010203');
});

test('firstAllowedUserId returns first numeric id from CSV', () => {
  expect(firstAllowedUserId({ TELEGRAM_ALLOWED_USER_IDS: 'not, 3, 4' })).toBe(3);
  expect(firstAllowedUserId({ TELEGRAM_ALLOWED_USER_IDS: '' })).toBe(null);
});

test('makeSmokePlan creates local non-migration run-all smoke plan', () => {
  const plan = makeSmokePlan({ approvalId: 'APR-TEST', allowedUserId: 3 });

  expect(plan).toMatchObject({
    story_id: 'STORY-APR-TEST',
    mode: 'approval',
    target_env: 'local',
    planned_files: [],
    migration_plan: { target: 'local', sql: '' },
    allowed_user_ids: [3],
    telegram_manual_smoke: true,
    command: 'scripts/gates/run-all.sh'
  });
  expect(JSON.stringify(plan)).not.toContain('production');
});

test('createRunAllSmokeApproval creates fresh approved approval and plan without executing shell', () => {
  const rootDir = makeTempRoot();
  const result = createRunAllSmokeApproval({
    rootDir,
    env: SAFE_ENV,
    approvalId: 'APR-TELEGRAM-RUN-ALL-SMOKE-TEST',
    expiresMinutes: 45
  });

  expect(result).toMatchObject({
    ok: true,
    approval_id: 'APR-TELEGRAM-RUN-ALL-SMOKE-TEST',
    plan_path: '.ralph/tmp/APR-TELEGRAM-RUN-ALL-SMOKE-TEST.json',
    status: 'APPROVED',
    run_all_enabled_required: true,
    command_to_send: '/run-all APR-TELEGRAM-RUN-ALL-SMOKE-TEST .ralph/tmp/APR-TELEGRAM-RUN-ALL-SMOKE-TEST.json'
  });

  const plan = JSON.parse(fs.readFileSync(path.join(rootDir, result.plan_path), 'utf8'));
  const approval = JSON.parse(fs.readFileSync(path.join(rootDir, '.ralph', 'approval-pending', `${result.approval_id}.json`), 'utf8'));

  expect(plan.command).toBe('scripts/gates/run-all.sh');
  expect(approval.status).toBe('APPROVED');
  expect(approval.allowed_user_ids).toEqual([3]);
  expect(approval.execution_connected).toBe(false);
  expect(approval.execution_requires_hash_verification).toBe(true);
  expect(fs.existsSync(path.join(rootDir, '.ralph', 'logs', 'execution.jsonl'))).toBe(false);
});

test('createRunAllSmokeApproval fails closed for invalid Telegram env', () => {
  const result = createRunAllSmokeApproval({
    rootDir: makeTempRoot(),
    env: {
      TELEGRAM_BOT_TOKEN: '<private bot token>',
      TELEGRAM_ALLOWED_USER_IDS: '<your telegram user id>',
      TELEGRAM_ALLOWED_CHAT_IDS: '<target chat id>'
    }
  });

  expect(result).toEqual({ ok: false, reason: 'telegram_env_invalid' });
});
