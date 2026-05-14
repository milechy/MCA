const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  RESUME_VERSION,
  RESUME_APPROVAL_ID_PREFIX,
  isStopped,
  redactRationale,
  resumeApprovalId,
  requestResumeApproval,
  findApprovedResumeApproval,
  consumeApprovedResume
} = require('../../src/ralph/resume-after-security-stop');
const { createStory, readStory, updateStory } = require('../../src/ralph/story-queue');
const { readApproval } = require('../../src/ralph/approval-manager');
const { APPROVAL_STATUSES, APPROVAL_TYPES } = require('../../src/ralph/types');
const { maybeAutoApproveForFullauto } = require('../../src/ralph/fullauto-auto-approver');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-resume-after-security-stop-'));
}

function seedRoles(rootDir, ids) {
  fs.mkdirSync(path.join(rootDir, '.ralph'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'roles.json'), JSON.stringify({ admin_user_ids: ids, owner_user_ids: ids, reviewer_user_ids: ids }));
}

function seedStoppedStory(rootDir, overrides = {}) {
  const c = createStory({
    story_id: 'STORY-RS-1',
    title: 'Stopped story',
    requirement: 'Demonstrate resume from STOPPED_SECURITY',
    mode: 'approval',
    target_env: 'local',
    requested_paths: ['docs/resume-demo.md'],
    ...overrides
  }, { rootDir, now: new Date() });
  expect(c.ok).toBe(true);
  // Force into STOPPED_SECURITY
  const u = updateStory('STORY-RS-1', {
    status: 'failed',
    current_phase: 'STOPPED_SECURITY',
    blocked_reason: 'risk_5_security_stop'
  }, { rootDir, now: new Date(), event: 'forced_security_stop_for_test' });
  expect(u.ok).toBe(true);
  return readStory(rootDir, 'STORY-RS-1');
}

test('isStopped recognizes STOPPED_SECURITY phase and failed/stopped statuses', () => {
  expect(isStopped({ current_phase: 'STOPPED_SECURITY' })).toBe(true);
  expect(isStopped({ current_phase: 'STOPPED' })).toBe(true);
  expect(isStopped({ status: 'stopped' })).toBe(true);
  expect(isStopped({ status: 'failed' })).toBe(true);
  expect(isStopped({ current_phase: 'PLAN' })).toBe(false);
  expect(isStopped(null)).toBe(false);
});

test('redactRationale strips secrets and tokens before persistence', () => {
  // NOSCAN-FIXTURE: the next line passes synthetic sk-*/ghp_*/api_key=... strings into redactRationale as INPUT so the redaction test can assert they are stripped. These are not real credentials.
  const r = redactRationale('investigation reveals leak: api_key=sk-or-v1-deadbeefXXXX1234567890abcdefghij and password=supersecret and email a@b.com and gh token ghp_abcdefghijklmnopqrstuvwxyz12345');
  expect(r).not.toContain('sk-or-v1-deadbeef');
  expect(r).not.toContain('supersecret');
  expect(r).not.toContain('a@b.com');
  expect(r).not.toMatch(/ghp_[A-Za-z0-9_]{20,}/);
});

test('resumeApprovalId encodes prefix + safe story id + timestamp', () => {
  const id = resumeApprovalId('STORY-RS-1', new Date('2026-05-14T05:00:00Z'));
  expect(id).toMatch(/^APR-RESUME-STORY-RS-1-20260514\d{6}$/);
});

test('requestResumeApproval refuses non-admin requester', () => {
  const root = tmpRoot();
  seedRoles(root, [1]);
  seedStoppedStory(root);
  const r = requestResumeApproval({ rootDir: root, story_id: 'STORY-RS-1', requester_user_id: 2, rationale: 'detailed-rationale-here' });
  expect(r).toMatchObject({ ok: false, reason: 'admin_required' });
});

test('requestResumeApproval refuses a story that is not in STOPPED state', () => {
  const root = tmpRoot();
  seedRoles(root, [1]);
  createStory({ story_id: 'STORY-OK', title: 'normal', requirement: 'x', requested_paths: ['docs/x.md'] }, { rootDir: root, now: new Date() });
  const r = requestResumeApproval({ rootDir: root, story_id: 'STORY-OK', requester_user_id: 1, rationale: 'detailed-rationale-here' });
  expect(r).toMatchObject({ ok: false, reason: 'story_not_in_security_stop_state' });
});

test('requestResumeApproval refuses an empty/too-short rationale', () => {
  const root = tmpRoot();
  seedRoles(root, [1]);
  seedStoppedStory(root);
  const r = requestResumeApproval({ rootDir: root, story_id: 'STORY-RS-1', requester_user_id: 1, rationale: 'short' });
  expect(r).toMatchObject({ ok: false, reason: 'rationale_too_short_min_8_chars' });
});

test('requestResumeApproval creates a pending APR-RESUME-* with the right type and audit event', () => {
  const root = tmpRoot();
  seedRoles(root, [1]);
  seedStoppedStory(root);
  const r = requestResumeApproval({ rootDir: root, story_id: 'STORY-RS-1', requester_user_id: 1, rationale: 'detailed-rationale-here-explaining-mitigations' });
  expect(r).toMatchObject({ ok: true, stage: 'resume_request', version: RESUME_VERSION, approval_type: APPROVAL_TYPES.RESUME_AFTER_SECURITY_STOP });
  expect(r.approval_id).toMatch(new RegExp(`^${RESUME_APPROVAL_ID_PREFIX}STORY-RS-1-`));
  const approval = readApproval(root, r.approval_id);
  expect(approval).toMatchObject({ status: APPROVAL_STATUSES.PENDING, approval_type: APPROVAL_TYPES.RESUME_AFTER_SECURITY_STOP });
});

test('consumeApprovedResume refuses when no approved resume approval exists', () => {
  const root = tmpRoot();
  seedRoles(root, [1]);
  seedStoppedStory(root);
  requestResumeApproval({ rootDir: root, story_id: 'STORY-RS-1', requester_user_id: 1, rationale: 'detailed-rationale-here' });
  const r = consumeApprovedResume({ rootDir: root, story_id: 'STORY-RS-1' });
  expect(r).toMatchObject({ ok: false, reason: 'no_approved_resume_approval_found' });
});

test('consumeApprovedResume transitions story back to PLAN_APPROVAL_PENDING and marks approval EXECUTED', () => {
  const root = tmpRoot();
  seedRoles(root, [1]);
  seedStoppedStory(root);
  const reqResult = requestResumeApproval({ rootDir: root, story_id: 'STORY-RS-1', requester_user_id: 1, rationale: 'detailed-rationale-here' });

  // Flip the approval to APPROVED on disk (simulating admin approve)
  const ap = readApproval(root, reqResult.approval_id);
  ap.status = APPROVAL_STATUSES.APPROVED;
  ap.approved_by = 'cli:1';
  ap.approved_at = new Date().toISOString();
  fs.writeFileSync(path.join(root, '.ralph', 'approval-pending', `${reqResult.approval_id}.json`), JSON.stringify(ap, null, 2));

  const r = consumeApprovedResume({ rootDir: root, story_id: 'STORY-RS-1' });
  expect(r).toMatchObject({ ok: true, transitioned: true, to_phase: 'PLAN_APPROVAL_PENDING' });
  expect(readStory(root, 'STORY-RS-1')).toMatchObject({
    current_phase: 'PLAN_APPROVAL_PENDING',
    status: 'queued',
    blocked_reason: null,
    last_resume_approval_id: reqResult.approval_id
  });
  expect(readApproval(root, reqResult.approval_id).status).toBe(APPROVAL_STATUSES.EXECUTED);
});

test('consumeApprovedResume is single-use: second call returns no_approved_resume_approval_found', () => {
  const root = tmpRoot();
  seedRoles(root, [1]);
  seedStoppedStory(root);
  const reqResult = requestResumeApproval({ rootDir: root, story_id: 'STORY-RS-1', requester_user_id: 1, rationale: 'detailed-rationale-here' });
  const ap = readApproval(root, reqResult.approval_id);
  ap.status = APPROVAL_STATUSES.APPROVED;
  ap.approved_by = 'cli:1';
  fs.writeFileSync(path.join(root, '.ralph', 'approval-pending', `${reqResult.approval_id}.json`), JSON.stringify(ap, null, 2));
  consumeApprovedResume({ rootDir: root, story_id: 'STORY-RS-1' });
  // Force the story back to STOPPED to attempt re-use
  updateStory('STORY-RS-1', { current_phase: 'STOPPED_SECURITY', status: 'failed' }, { rootDir: root, now: new Date(), event: 'forced_re_stop_for_test' });
  const r2 = consumeApprovedResume({ rootDir: root, story_id: 'STORY-RS-1' });
  expect(r2).toMatchObject({ ok: false, reason: 'no_approved_resume_approval_found' });
});

test('fullauto auto-approver REFUSES to auto-approve RESUME_AFTER_SECURITY_STOP approvals', () => {
  const root = tmpRoot();
  seedRoles(root, [1]);
  // mode = fullauto
  fs.writeFileSync(path.join(root, '.ralph', 'mode.json'), JSON.stringify({ mode: 'fullauto', effective_until: new Date(Date.now() + 60_000).toISOString() }));
  seedStoppedStory(root);
  const req = requestResumeApproval({ rootDir: root, story_id: 'STORY-RS-1', requester_user_id: 1, rationale: 'detailed-rationale-here' });
  updateStory('STORY-RS-1', { current_approval_id: req.approval_id }, { rootDir: root, now: new Date(), event: 'attach_resume_approval_for_test' });
  const story = readStory(root, 'STORY-RS-1');

  const r = maybeAutoApproveForFullauto({ rootDir: root, story });
  expect(r).toMatchObject({ ok: true, approved: false });
  expect(readApproval(root, req.approval_id).status).toBe(APPROVAL_STATUSES.PENDING);
});

test('findApprovedResumeApproval ignores expired and non-matching records', () => {
  const root = tmpRoot();
  seedRoles(root, [1]);
  seedStoppedStory(root);
  // expired resume approval
  const expired = requestResumeApproval({ rootDir: root, story_id: 'STORY-RS-1', requester_user_id: 1, rationale: 'detailed-rationale-here', expires_hours: 1 });
  const p = path.join(root, '.ralph', 'approval-pending', `${expired.approval_id}.json`);
  const exObj = JSON.parse(fs.readFileSync(p, 'utf8'));
  exObj.status = APPROVAL_STATUSES.APPROVED;
  exObj.expires_at = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(p, JSON.stringify(exObj, null, 2));
  expect(findApprovedResumeApproval(root, 'STORY-RS-1')).toBeNull();
});
