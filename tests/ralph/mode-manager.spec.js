const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MODES,
  loadMode,
  requestFullautoMode,
  confirmFullautoMode,
  setApprovalMode,
  autoRevertExpiredMode
} = require('../../src/ralph/mode-manager');

function makeTempRoot(initialMode = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-mode-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'logs', 'audit.jsonl'), '', 'utf8');
  fs.writeFileSync(
    path.join(rootDir, '.ralph', 'mode.json'),
    `${JSON.stringify({
      mode: MODES.APPROVAL,
      effective_until: null,
      auto_revert_to: null,
      changed_by: { channel: 'manual', user: 'test' },
      policy_version: 'approval-policy-v1.4',
      reason: 'test_setup',
      updated_at: '2026-05-06T00:00:00+09:00',
      ...initialMode
    }, null, 2)}\n`,
    'utf8'
  );
  return rootDir;
}

function roles() {
  return {
    owner_user_ids: [1],
    admin_user_ids: [2],
    reviewer_user_ids: [3]
  };
}

function readAudit(rootDir) {
  const auditPath = path.join(rootDir, '.ralph', 'logs', 'audit.jsonl');
  return fs.readFileSync(auditPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('reviewer can switch to approval mode immediately', () => {
  const rootDir = makeTempRoot({ mode: MODES.FULLAUTO, effective_until: new Date(Date.now() + 60_000).toISOString(), auto_revert_to: MODES.APPROVAL });

  const result = setApprovalMode(3, { rootDir, roles: roles(), reason: 'manual safety' });

  expect(result.ok).toBe(true);
  expect(result.mode.mode).toBe(MODES.APPROVAL);
  expect(result.mode.effective_until).toBeNull();
  expect(readAudit(rootDir)[0].event).toBe('mode_changed');
});

test('observer cannot switch to approval mode', () => {
  const rootDir = makeTempRoot();

  const result = setApprovalMode(999, { rootDir, roles: roles() });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('reviewer_or_admin_required');
  expect(loadMode(rootDir).mode).toBe(MODES.APPROVAL);
});

test('fullauto requires admin and confirmation token', () => {
  const rootDir = makeTempRoot();

  const denied = requestFullautoMode(3, { rootDir, roles: roles(), token: 'MODE-TEST-DENIED' });
  expect(denied.ok).toBe(false);
  expect(denied.reason).toBe('admin_required');

  const requested = requestFullautoMode(2, { rootDir, roles: roles(), token: 'MODE-TEST-ALLOW', hours: 6 });
  expect(requested.ok).toBe(true);
  expect(loadMode(rootDir).mode).toBe(MODES.APPROVAL);

  const confirmed = confirmFullautoMode('MODE-TEST-ALLOW', 2, { rootDir, roles: roles() });
  expect(confirmed.ok).toBe(true);
  expect(confirmed.mode.mode).toBe(MODES.FULLAUTO);
  expect(confirmed.mode.auto_revert_to).toBe(MODES.APPROVAL);
});

test('fullauto duration is capped at 24 hours', () => {
  const rootDir = makeTempRoot();

  const requested = requestFullautoMode(2, { rootDir, roles: roles(), token: 'MODE-TEST-CAP', hours: 999 });
  const confirmed = confirmFullautoMode(requested.token, 2, { rootDir, roles: roles() });

  const durationMs = new Date(confirmed.mode.effective_until).getTime() - Date.now();
  expect(durationMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
});

test('expired fullauto mode auto-reverts to approval', () => {
  const rootDir = makeTempRoot({
    mode: MODES.FULLAUTO,
    effective_until: new Date(Date.now() - 1000).toISOString(),
    auto_revert_to: MODES.APPROVAL
  });

  const result = autoRevertExpiredMode({ rootDir });

  expect(result.changed).toBe(true);
  expect(result.mode.mode).toBe(MODES.APPROVAL);
  expect(result.mode.reason).toBe('fullauto_expired');
});
