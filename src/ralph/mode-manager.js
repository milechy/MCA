const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { appendAuditEvent } = require('./audit-log');

const MODES = Object.freeze({
  APPROVAL: 'approval',
  FULLAUTO: 'fullauto'
});

const DEFAULT_POLICY_VERSION = 'approval-policy-v1.4';
const DEFAULT_FULLAUTO_HOURS = 6;
const MAX_FULLAUTO_HOURS = 24;

function modePath(rootDir) {
  return path.join(rootDir, '.ralph', 'mode.json');
}

function pendingModeChangePath(rootDir, token) {
  return path.join(rootDir, '.ralph', 'approval-pending', `${token}.mode-change.json`);
}

function nowIso() {
  return new Date().toISOString();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function loadMode(rootDir = process.cwd()) {
  return readJson(modePath(rootDir));
}

function saveMode(modeState, rootDir = process.cwd()) {
  const next = {
    ...modeState,
    updated_at: nowIso()
  };
  writeJson(modePath(rootDir), next);
  return next;
}

function isAdmin(userId, roles = {}) {
  const admins = roles.admin_user_ids || roles.owner_user_ids || [];
  const owners = roles.owner_user_ids || [];
  return admins.includes(userId) || owners.includes(userId);
}

function isReviewerOrHigher(userId, roles = {}) {
  const reviewers = roles.reviewer_user_ids || [];
  return isAdmin(userId, roles) || reviewers.includes(userId);
}

function hoursToIso(hours, baseDate = new Date()) {
  return new Date(baseDate.getTime() + hours * 60 * 60 * 1000).toISOString();
}

function requestFullautoMode(userId, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const roles = options.roles || {};
  const hours = Math.min(Number(options.hours || DEFAULT_FULLAUTO_HOURS), MAX_FULLAUTO_HOURS);

  if (!isAdmin(userId, roles)) {
    return { ok: false, reason: 'admin_required' };
  }

  const token = options.token || `MODE-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(4).toString('hex')}`;
  const request = {
    token,
    requested_mode: MODES.FULLAUTO,
    requested_by: `cli:${userId}`,
    requested_at: nowIso(),
    effective_hours: hours,
    expires_at: hoursToIso(10 / 60),
    status: 'pending_confirmation'
  };

  writeJson(pendingModeChangePath(rootDir, token), request);
  appendAuditEvent({ event: 'mode_change_requested', token, requested_mode: MODES.FULLAUTO, requested_by: request.requested_by }, {
    filePath: path.join(rootDir, '.ralph', 'logs', 'audit.jsonl')
  });

  return { ok: true, token, request };
}

function confirmFullautoMode(token, userId, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const roles = options.roles || {};

  if (!isAdmin(userId, roles)) {
    return { ok: false, reason: 'admin_required' };
  }

  const requestPath = pendingModeChangePath(rootDir, token);
  if (!fs.existsSync(requestPath)) {
    return { ok: false, reason: 'mode_change_request_not_found' };
  }

  const request = readJson(requestPath);
  if (request.status !== 'pending_confirmation') {
    return { ok: false, reason: `request_status_${request.status}` };
  }

  if (new Date(request.expires_at).getTime() < Date.now()) {
    request.status = 'expired';
    writeJson(requestPath, request);
    return { ok: false, reason: 'mode_change_request_expired' };
  }

  const nextMode = saveMode({
    mode: MODES.FULLAUTO,
    effective_until: hoursToIso(request.effective_hours),
    auto_revert_to: MODES.APPROVAL,
    changed_by: {
      channel: 'cli',
      user_id: userId
    },
    policy_version: options.policy_version || DEFAULT_POLICY_VERSION,
    reason: options.reason || 'confirmed_fullauto_mode'
  }, rootDir);

  request.status = 'confirmed';
  request.confirmed_by = `cli:${userId}`;
  request.confirmed_at = nowIso();
  writeJson(requestPath, request);

  appendAuditEvent({ event: 'mode_changed', mode: MODES.FULLAUTO, changed_by: `cli:${userId}`, effective_until: nextMode.effective_until }, {
    filePath: path.join(rootDir, '.ralph', 'logs', 'audit.jsonl')
  });

  return { ok: true, mode: nextMode };
}

function setApprovalMode(userId, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const roles = options.roles || {};

  if (!isReviewerOrHigher(userId, roles)) {
    return { ok: false, reason: 'reviewer_or_admin_required' };
  }

  const nextMode = saveMode({
    mode: MODES.APPROVAL,
    effective_until: null,
    auto_revert_to: null,
    changed_by: {
      channel: 'cli',
      user_id: userId
    },
    policy_version: options.policy_version || DEFAULT_POLICY_VERSION,
    reason: options.reason || 'manual_approval_mode'
  }, rootDir);

  appendAuditEvent({ event: 'mode_changed', mode: MODES.APPROVAL, changed_by: `cli:${userId}` }, {
    filePath: path.join(rootDir, '.ralph', 'logs', 'audit.jsonl')
  });

  return { ok: true, mode: nextMode };
}

function autoRevertExpiredMode(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const modeState = loadMode(rootDir);

  if (modeState.mode !== MODES.FULLAUTO || !modeState.effective_until) {
    return { changed: false, mode: modeState };
  }

  if (new Date(modeState.effective_until).getTime() > Date.now()) {
    return { changed: false, mode: modeState };
  }

  const nextMode = saveMode({
    mode: modeState.auto_revert_to || MODES.APPROVAL,
    effective_until: null,
    auto_revert_to: null,
    changed_by: {
      channel: 'system',
      user: 'auto_revert'
    },
    policy_version: modeState.policy_version || DEFAULT_POLICY_VERSION,
    reason: 'fullauto_expired'
  }, rootDir);

  appendAuditEvent({ event: 'mode_auto_reverted', from: MODES.FULLAUTO, to: nextMode.mode }, {
    filePath: path.join(rootDir, '.ralph', 'logs', 'audit.jsonl')
  });

  return { changed: true, mode: nextMode };
}

module.exports = {
  MODES,
  DEFAULT_FULLAUTO_HOURS,
  MAX_FULLAUTO_HOURS,
  loadMode,
  saveMode,
  requestFullautoMode,
  confirmFullautoMode,
  setApprovalMode,
  autoRevertExpiredMode,
  isAdmin,
  isReviewerOrHigher
};
