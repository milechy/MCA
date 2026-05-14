const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { processTelegramUpdate } = require('../../src/telegram/bot');
const { createStory, readStory, updateStory } = require('../../src/ralph/story-queue');
const { createApproval, readApproval } = require('../../src/ralph/approval-manager');
const { APPROVAL_STATUSES, APPROVAL_TYPES } = require('../../src/ralph/types');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-e2e-'));
}

function seedRoles(rootDir, ids) {
  fs.mkdirSync(path.join(rootDir, '.ralph'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'roles.json'), JSON.stringify({ admin_user_ids: ids, owner_user_ids: ids, reviewer_user_ids: ids }));
}

function authedUpdate(text, userId = 1, chatId = 100) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      from: { id: userId, is_bot: false, first_name: 'Op' },
      chat: { id: chatId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text
    }
  };
}

function envFor(userId = 1, chatId = 100) {
  return {
    TELEGRAM_BOT_TOKEN: 'fake:token',
    TELEGRAM_ALLOWED_USER_IDS: String(userId),
    TELEGRAM_ALLOWED_CHAT_IDS: String(chatId),
    TELEGRAM_DRY_RUN: 'true'
  };
}

test('Telegram /approve drives an existing approval through approveApprovalRecordOnly', async () => {
  const rootDir = tmpRoot();
  seedRoles(rootDir, [1]);
  const c = createStory({ story_id: 'STORY-E2E-APV', title: 't', requirement: 'r', requested_paths: ['docs/x.md'] }, { rootDir, now: new Date() });
  expect(c.ok).toBe(true);
  const approvalId = 'APR-OPENCODE-APPLY-E2E-APV';
  createApproval(
    { story_id: 'STORY-E2E-APV', objective: 'noop', requested_paths: ['docs/x.md'] },
    { score: 0, category: 'low', label: 'RISK_0_LOW', requires_approval: true },
    {
      rootDir,
      approval_id: approvalId,
      approval_type: APPROVAL_TYPES.DIFF,
      requested_action: 'opencode_candidate_patch',
      allowed_user_ids: [1],
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    }
  );
  expect(readApproval(rootDir, approvalId).status).toBe(APPROVAL_STATUSES.PENDING);

  const response = await processTelegramUpdate(authedUpdate(`/approve ${approvalId}`), {
    rootDir,
    env: envFor()
  });

  expect(response.ok).toBe(true);
  expect(readApproval(rootDir, approvalId).status).toBe(APPROVAL_STATUSES.APPROVED);
  expect(readApproval(rootDir, approvalId).approved_by).toBe('telegram:1');
});

test('Telegram /resume-request creates an APR-RESUME-* record for an admin on a stopped story', async () => {
  const rootDir = tmpRoot();
  seedRoles(rootDir, [1]);
  createStory({ story_id: 'STORY-E2E-RES', title: 't', requirement: 'r', requested_paths: ['docs/x.md'] }, { rootDir, now: new Date() });
  updateStory('STORY-E2E-RES', { status: 'failed', current_phase: 'STOPPED_SECURITY' }, { rootDir, now: new Date(), event: 'forced_stop_for_test' });

  const response = await processTelegramUpdate(authedUpdate('/resume-request STORY-E2E-RES detailed-rationale-text-here'), {
    rootDir,
    env: envFor()
  });

  expect(response.ok).toBe(true);
  const result = response.response && response.response.result;
  expect(result).toMatchObject({
    ok: true,
    action: 'resume_request',
    story_id: 'STORY-E2E-RES'
  });
  expect(result.approval_id).toMatch(/^APR-RESUME-STORY-E2E-RES-/);
  expect(readApproval(rootDir, result.approval_id).status).toBe(APPROVAL_STATUSES.PENDING);
});

test('Telegram /resume-request refuses a non-admin user_id', async () => {
  const rootDir = tmpRoot();
  seedRoles(rootDir, [99]); // admin is 99, our user is 1
  createStory({ story_id: 'STORY-E2E-RES-DENY', title: 't', requirement: 'r', requested_paths: ['docs/x.md'] }, { rootDir, now: new Date() });
  updateStory('STORY-E2E-RES-DENY', { status: 'failed', current_phase: 'STOPPED_SECURITY' }, { rootDir, now: new Date(), event: 'forced_stop_for_test' });

  const response = await processTelegramUpdate(authedUpdate('/resume-request STORY-E2E-RES-DENY detailed-rationale-text-here'), {
    rootDir,
    env: envFor()
  });

  // The update is auth-allowed (user 1 is in TELEGRAM_ALLOWED_USER_IDS) but
  // the admin check inside resume-request must still refuse.
  const result = response.response && response.response.result;
  expect(result).toMatchObject({ ok: false, action: 'resume_request', reason: 'admin_required' });
});

test('Telegram /resume-status reports a stopped story and the pending approved-resume record if any', async () => {
  const rootDir = tmpRoot();
  seedRoles(rootDir, [1]);
  createStory({ story_id: 'STORY-E2E-STAT', title: 't', requirement: 'r', requested_paths: ['docs/x.md'] }, { rootDir, now: new Date() });
  updateStory('STORY-E2E-STAT', { status: 'failed', current_phase: 'STOPPED_SECURITY', blocked_reason: 'risk_5_security_stop' }, { rootDir, now: new Date(), event: 'forced_stop_for_test' });

  // Create + approve a resume record manually
  const approvalId = 'APR-RESUME-STORY-E2E-STAT-20260514000000';
  createApproval(
    { story_id: 'STORY-E2E-STAT', objective: 'resume', requested_paths: ['docs/x.md'], rationale: 'redacted-rationale' },
    { score: 0, category: 'low', label: 'RISK_RESUME', requires_approval: true },
    {
      rootDir,
      approval_id: approvalId,
      approval_type: APPROVAL_TYPES.RESUME_AFTER_SECURITY_STOP,
      requested_action: 'resume_after_security_stop',
      allowed_user_ids: [1],
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    }
  );
  const ap = readApproval(rootDir, approvalId);
  ap.status = APPROVAL_STATUSES.APPROVED;
  ap.approved_by = 'telegram:1';
  fs.writeFileSync(path.join(rootDir, '.ralph', 'approval-pending', `${approvalId}.json`), JSON.stringify(ap, null, 2));

  const response = await processTelegramUpdate(authedUpdate('/resume-status STORY-E2E-STAT'), {
    rootDir,
    env: envFor()
  });

  const result = response.response && response.response.result;
  expect(result).toMatchObject({
    ok: true,
    action: 'resume_status',
    story_id: 'STORY-E2E-STAT',
    current_phase: 'STOPPED_SECURITY',
    is_security_stopped: true,
    pending_approved_resume_approval_id: approvalId
  });
});

test('Telegram surface rejects unauthorized user_id without touching state', async () => {
  const rootDir = tmpRoot();
  seedRoles(rootDir, [1]);
  createStory({ story_id: 'STORY-E2E-NOAUTH', title: 't', requirement: 'r', requested_paths: ['docs/x.md'] }, { rootDir, now: new Date() });
  updateStory('STORY-E2E-NOAUTH', { status: 'failed', current_phase: 'STOPPED_SECURITY' }, { rootDir, now: new Date(), event: 'forced_stop' });

  const response = await processTelegramUpdate(
    authedUpdate('/resume-request STORY-E2E-NOAUTH detailed-rationale', /*userId=*/ 999, /*chatId=*/ 999),
    {
      rootDir,
      env: { ...envFor(1, 100) } // user 999 is NOT allowed
    }
  );

  expect(response.ok).toBe(false);
  expect(response.reason).toContain('user');
  // Story state untouched
  expect(readStory(rootDir, 'STORY-E2E-NOAUTH')).toMatchObject({ current_phase: 'STOPPED_SECURITY' });
});
