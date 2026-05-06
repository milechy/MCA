const fs = require('node:fs');
const path = require('node:path');

function approvalPendingDir(rootDir = process.cwd()) {
  return path.join(rootDir, '.ralph', 'approval-pending');
}

function safeReadApproval(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return null;
  }
}

function listApprovals(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const status = options.status || null;
  const dir = approvalPendingDir(rootDir);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter((fileName) => fileName.endsWith('.json'))
    .map((fileName) => safeReadApproval(path.join(dir, fileName)))
    .filter(Boolean)
    .filter((approval) => !status || approval.status === status)
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

function getApproval(approvalId, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const filePath = path.join(approvalPendingDir(rootDir), `${approvalId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return safeReadApproval(filePath);
}

function summarizeApproval(approval) {
  return {
    approval_id: approval.approval_id,
    approval_type: approval.approval_type,
    story_id: approval.story_id,
    status: approval.status,
    risk: approval.risk,
    requested_action: approval.requested_action,
    plan_summary: approval.plan_summary,
    expires_at: approval.expires_at,
    plan_hash: approval.plan_hash,
    pre_exec_diff_hash: approval.pre_exec_diff_hash
  };
}

module.exports = {
  approvalPendingDir,
  listApprovals,
  getApproval,
  summarizeApproval
};
