#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { createApproval, approveApprovalRecordOnly } = require('../../src/ralph/approval-manager');
const { evaluateRisk } = require('../../src/ralph/risk-evaluator');
const { APPROVAL_STATUSES } = require('../../src/ralph/types');
const { EMPTY_DIFF_HASH } = require('../../src/telegram/execution-adapter');
const { status } = require('./check-env');
const { preflightNoSecrets } = require('./preflight-no-secrets');

function nowStamp(date = new Date()) {
  return date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function firstAllowedUserId(env = process.env) {
  const value = env.TELEGRAM_ALLOWED_USER_IDS || '';
  const [first] = value.split(',').map((entry) => Number(entry.trim())).filter((entry) => Number.isFinite(entry));
  return first || null;
}

function makeSmokePlan({ approvalId, allowedUserId }) {
  return {
    story_id: `STORY-${approvalId}`,
    mode: 'approval',
    target_env: 'local',
    summary: 'Telegram explicit-gate run-all smoke approval',
    objective: 'Validate Telegram explicit-gate /run-all can execute only the allowlisted local gates command after approval, hash, diff, command allowlist, and env gates pass.',
    planned_files: [],
    migration_plan: { target: 'local', sql: '' },
    allowed_user_ids: [allowedUserId],
    telegram_manual_smoke: true,
    command: 'scripts/gates/run-all.sh'
  };
}

function writePlan(rootDir, planPath, plan) {
  const absolutePath = path.join(rootDir, planPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return planPath;
}

function createRunAllSmokeApproval({ rootDir = process.cwd(), env = process.env, approvalId = null, expiresMinutes = 30 } = {}) {
  const envStatus = status(env);
  if (!envStatus.ok) {
    return { ok: false, reason: 'telegram_env_invalid' };
  }

  const secretPreflight = preflightNoSecrets({ rootDir, includeGitDiff: true });
  if (!secretPreflight.ok) {
    return { ok: false, reason: 'repo_secret_preflight_failed', findings_count: secretPreflight.findings.length };
  }

  const allowedUserId = firstAllowedUserId(env);
  if (!allowedUserId) {
    return { ok: false, reason: 'allowed_user_id_required' };
  }

  const id = approvalId || `APR-TELEGRAM-RUN-ALL-SMOKE-${nowStamp()}`;
  const planPath = `.ralph/tmp/${id}.json`;
  const plan = makeSmokePlan({ approvalId: id, allowedUserId });
  writePlan(rootDir, planPath, plan);

  const expiresAt = new Date(Date.now() + expiresMinutes * 60 * 1000).toISOString();
  const approval = createApproval(plan, evaluateRisk(plan), {
    rootDir,
    approval_id: id,
    allowed_user_ids: [allowedUserId],
    pre_exec_diff_hash: EMPTY_DIFF_HASH,
    expires_at: expiresAt,
    requested_action: 'telegram_run_all_smoke'
  });
  const approved = approveApprovalRecordOnly(approval.approval_id, allowedUserId, { rootDir, channel: 'telegram-smoke' });

  return {
    ok: approved.status === APPROVAL_STATUSES.APPROVED,
    approval_id: id,
    plan_path: planPath,
    expires_at: approved.expires_at,
    status: approved.status,
    run_all_enabled_required: true,
    command_to_send: `/run-all ${id} ${planPath}`,
    notes: [
      'Send command_to_send from the authorized Telegram user/chat only after setting RALPH_TELEGRAM_RUN_ALL_ENABLED=true in the local shell.',
      'This helper creates approval and plan only; it does not execute shell commands.'
    ]
  };
}

function main() {
  const result = createRunAllSmokeApproval({ rootDir: process.cwd(), env: process.env });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  nowStamp,
  firstAllowedUserId,
  makeSmokePlan,
  writePlan,
  createRunAllSmokeApproval
};
