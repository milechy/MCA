const fs = require('node:fs');
const path = require('node:path');
const { assertSandboxLocalPath } = require('./opencode-sandbox-runner');
const { isForbiddenRequestedPath, isAllowedRequestedPath } = require('./opencode-sandbox-preflight');

const MAX_DIFF_BYTES = 64 * 1024;
const MAX_PREVIEW_CHARS = 1200;

function oneLine(value, maxLength = 180) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function boundedPreview(value, maxLength = MAX_PREVIEW_CHARS) {
  const text = String(value || '')
    .replace(/\b\d{8,}:[A-Za-z0-9_-]{20,}\b/g, '<redacted>')
    .replace(/ghp_[A-Za-z0-9_]{20,}/g, '<redacted>')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, '<redacted>');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function candidatePatchPath(rootDir, sandboxRoot) {
  return path.join(rootDir, sandboxRoot, 'candidate.patch');
}

function extractTouchedFiles(diffText) {
  const files = new Set();
  const lines = String(diffText || '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) {
      files.add(match[1]);
      files.add(match[2]);
      continue;
    }
    const plus = line.match(/^\+\+\+ b\/(.+)$/);
    if (plus) files.add(plus[1]);
    const minus = line.match(/^--- a\/(.+)$/);
    if (minus) files.add(minus[1]);
  }
  return Array.from(files).filter((file) => file !== '/dev/null').slice(0, 50);
}

function classifyRisk(filesTouched, diffText = '') {
  const files = filesTouched || [];
  const text = String(diffText || '').toLowerCase();

  if (files.length === 0 && !text.trim()) {
    return { score: 0, label: 'RISK_0_EMPTY_CANDIDATE', category: 'none' };
  }

  if (files.some((file) => file.includes('..') || file.startsWith('/') || file === '.env' || file.startsWith('.env.')) || /drop\s+table|delete\s+from|truncate\s+table|production deploy|secret/.test(text)) {
    return { score: 5, label: 'RISK_5_BLOCKED_SECRET_OR_DESTRUCTIVE', category: 'blocked' };
  }

  if (files.some((file) => file.startsWith('supabase/') || file.startsWith('.github/') || file.startsWith('infra/') || file.includes('migration') || file.includes('auth'))) {
    return { score: 4, label: 'RISK_4_INFRA_DATABASE_OR_AUTH', category: 'high' };
  }

  if (files.some((file) => file.startsWith('src/auth') || file.startsWith('src/security') || file.includes('permission') || file.includes('policy'))) {
    return { score: 3, label: 'RISK_3_SECURITY_SENSITIVE_APP_PATH', category: 'elevated' };
  }

  if (files.some((file) => file === 'package.json' || file === 'package-lock.json' || file.endsWith('.config.js') || file.endsWith('.config.ts') || file.startsWith('config/'))) {
    return { score: 2, label: 'RISK_2_PACKAGE_OR_CONFIG', category: 'medium' };
  }

  if (files.every((file) => file.startsWith('docs/') || file.startsWith('tests/') || file.endsWith('.md'))) {
    return { score: 0, label: 'RISK_0_DOCS_OR_TESTS_ONLY', category: 'low' };
  }

  return { score: 1, label: 'RISK_1_LOCAL_SOURCE_PREVIEW', category: 'low' };
}

function makeBaseResult(overrides = {}) {
  return {
    ok: false,
    stage: 'opencode_candidate_patch_preview',
    reason: null,
    approval_id: null,
    sandbox_root: null,
    candidate_patch_path: null,
    diff_bytes: 0,
    diff_preview: '',
    files_touched: [],
    blocked_paths: [],
    risk: { score: 5, label: 'RISK_5_BLOCKED', category: 'blocked' },
    requires_approval: true,
    apply_allowed: false,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'fix_candidate_patch_preview_failure',
    ...overrides
  };
}

function previewOpenCodeCandidatePatch({ rootDir = process.cwd(), approval_id, sandbox_root, candidate_patch_path } = {}) {
  const expectedPath = sandbox_root ? candidatePatchPath(rootDir, sandbox_root) : null;
  const patchPath = candidate_patch_path || expectedPath;
  const base = {
    approval_id: approval_id || null,
    sandbox_root: sandbox_root || null,
    candidate_patch_path: patchPath ? path.relative(rootDir, patchPath).replace(/\\/g, '/') : null
  };

  if (!approval_id) return makeBaseResult({ ...base, reason: 'approval_id_required' });
  if (!sandbox_root || !patchPath) return makeBaseResult({ ...base, reason: 'candidate_patch_path_required' });
  if (!assertSandboxLocalPath(rootDir, sandbox_root, patchPath)) return makeBaseResult({ ...base, reason: 'candidate_patch_path_not_allowed' });
  if (!fs.existsSync(patchPath)) {
    return makeBaseResult({
      ...base,
      ok: true,
      reason: 'candidate_patch_missing',
      risk: { score: 0, label: 'RISK_0_EMPTY_CANDIDATE', category: 'none' },
      requires_approval: false,
      next_action: 'no_patch_to_review'
    });
  }

  const stat = fs.statSync(patchPath);
  if (stat.size > MAX_DIFF_BYTES) return makeBaseResult({ ...base, diff_bytes: stat.size, reason: 'candidate_patch_too_large' });

  const diffText = fs.readFileSync(patchPath, 'utf8');
  const filesTouched = extractTouchedFiles(diffText);
  const blockedPaths = filesTouched.filter((file) => isForbiddenRequestedPath(file) || !isAllowedRequestedPath(file));
  const risk = classifyRisk(filesTouched, diffText);
  const blocked = blockedPaths.length > 0 || risk.score >= 5;

  return makeBaseResult({
    ...base,
    ok: !blocked,
    reason: blocked ? (blockedPaths.length > 0 ? 'candidate_patch_forbidden_path' : 'candidate_patch_blocked_risk') : null,
    diff_bytes: Buffer.byteLength(diffText, 'utf8'),
    diff_preview: boundedPreview(diffText),
    files_touched: filesTouched,
    blocked_paths: blockedPaths,
    risk,
    requires_approval: diffText.trim().length > 0,
    next_action: blocked ? 'reject_or_replan_candidate_patch' : 'request_approval_before_any_apply_phase'
  });
}

module.exports = {
  MAX_DIFF_BYTES,
  MAX_PREVIEW_CHARS,
  oneLine,
  boundedPreview,
  candidatePatchPath,
  extractTouchedFiles,
  classifyRisk,
  previewOpenCodeCandidatePatch
};
