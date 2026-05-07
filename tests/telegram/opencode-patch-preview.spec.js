const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseTelegramCommand } = require('../../src/telegram/command-parser');
const { handleTelegramCommand } = require('../../src/telegram/handlers');
const {
  MAX_DIFF_BYTES,
  boundedPreview,
  candidatePatchPath,
  extractTouchedFiles,
  classifyRisk,
  previewOpenCodeCandidatePatch
} = require('../../src/telegram/opencode-patch-preview');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-patch-preview-'));
}

function writeCandidatePatch(rootDir, approvalId, content) {
  const sandboxRoot = `.ralph/tmp/opencode-sandbox/${approvalId}`;
  const patchPath = candidatePatchPath(rootDir, sandboxRoot);
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.writeFileSync(patchPath, content);
  return { sandboxRoot, patchPath };
}

const TEST_DIFF = `diff --git a/tests/foo.spec.js b/tests/foo.spec.js
index 1111111..2222222 100644
--- a/tests/foo.spec.js
+++ b/tests/foo.spec.js
@@ -1,2 +1,3 @@
 test('old', () => {});
+test('new', () => {});
`;

test('parseTelegramCommand parses /opencode-patch-preview', () => {
  const parsed = parseTelegramCommand('/opencode-patch-preview APR-ONE .ralph/tmp/opencode-sandbox/APR-ONE .ralph/tmp/opencode-sandbox/APR-ONE/candidate.patch');
  expect(parsed.type).toBe('opencode_patch_preview');
  expect(parsed.args).toEqual(['APR-ONE', '.ralph/tmp/opencode-sandbox/APR-ONE', '.ralph/tmp/opencode-sandbox/APR-ONE/candidate.patch']);
});

test('candidate patch preview helpers extract files and classify risk', () => {
  expect(extractTouchedFiles(TEST_DIFF)).toEqual(['tests/foo.spec.js']);
  expect(classifyRisk(['tests/foo.spec.js'], TEST_DIFF)).toMatchObject({ score: 0, label: 'RISK_0_DOCS_OR_TESTS_ONLY' });
  expect(classifyRisk(['src/foo.js'], TEST_DIFF)).toMatchObject({ score: 1, label: 'RISK_1_LOCAL_SOURCE_PREVIEW' });
  expect(classifyRisk(['package.json'], TEST_DIFF)).toMatchObject({ score: 2, label: 'RISK_2_PACKAGE_OR_CONFIG' });
  expect(classifyRisk(['supabase/migrations/001.sql'], TEST_DIFF)).toMatchObject({ score: 4, label: 'RISK_4_INFRA_DATABASE_OR_AUTH' });
  expect(classifyRisk(['.env'], TEST_DIFF)).toMatchObject({ score: 5, label: 'RISK_5_BLOCKED_SECRET_OR_DESTRUCTIVE' });
});

test('candidate patch preview bounds and redacts diff preview', () => {
  const preview = boundedPreview(`token 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi\n${'x'.repeat(2000)}`);
  expect(preview.length).toBeLessThanOrEqual(1200);
  expect(preview).toContain('<redacted>');
  expect(preview).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi');
});

test('OpenCode candidate patch preview succeeds for docs/tests patch without allowing apply', () => {
  const rootDir = makeRoot();
  const approvalId = 'APR-OPENCODE-PATCH-1';
  const { sandboxRoot, patchPath } = writeCandidatePatch(rootDir, approvalId, TEST_DIFF);

  const result = previewOpenCodeCandidatePatch({ rootDir, approval_id: approvalId, sandbox_root: sandboxRoot, candidate_patch_path: patchPath });

  expect(result).toMatchObject({
    ok: true,
    stage: 'opencode_candidate_patch_preview',
    reason: null,
    approval_id: approvalId,
    sandbox_root: sandboxRoot,
    candidate_patch_path: `.ralph/tmp/opencode-sandbox/${approvalId}/candidate.patch`,
    files_touched: ['tests/foo.spec.js'],
    blocked_paths: [],
    risk: { score: 0, label: 'RISK_0_DOCS_OR_TESTS_ONLY', category: 'low' },
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
    next_action: 'request_approval_before_any_apply_phase'
  });
  expect(result.diff_bytes).toBe(Buffer.byteLength(TEST_DIFF, 'utf8'));
  expect(result.diff_preview).toContain("test('new'");
});

test('OpenCode candidate patch preview blocks forbidden path and oversized patch', () => {
  const rootDir = makeRoot();
  const approvalId = 'APR-OPENCODE-PATCH-2';
  const forbiddenDiff = `diff --git a/.env b/.env
--- a/.env
+++ b/.env
@@ -0,0 +1 @@
+SECRET=value
`;
  const { sandboxRoot, patchPath } = writeCandidatePatch(rootDir, approvalId, forbiddenDiff);
  const blocked = previewOpenCodeCandidatePatch({ rootDir, approval_id: approvalId, sandbox_root: sandboxRoot, candidate_patch_path: patchPath });
  expect(blocked.ok).toBe(false);
  expect(blocked.reason).toBe('candidate_patch_forbidden_path');
  expect(blocked.apply_allowed).toBe(false);
  expect(blocked.blocked_paths).toEqual(['.env']);

  const largeApprovalId = 'APR-OPENCODE-PATCH-3';
  const large = writeCandidatePatch(rootDir, largeApprovalId, 'x'.repeat(MAX_DIFF_BYTES + 1));
  const largeResult = previewOpenCodeCandidatePatch({ rootDir, approval_id: largeApprovalId, sandbox_root: large.sandboxRoot, candidate_patch_path: large.patchPath });
  expect(largeResult.ok).toBe(false);
  expect(largeResult.reason).toBe('candidate_patch_too_large');
  expect(largeResult.diff_bytes).toBe(MAX_DIFF_BYTES + 1);
});

test('OpenCode candidate patch preview blocks path outside sandbox', () => {
  const rootDir = makeRoot();
  const approvalId = 'APR-OPENCODE-PATCH-4';
  const sandboxRoot = `.ralph/tmp/opencode-sandbox/${approvalId}`;
  const outsidePath = path.join(rootDir, 'candidate.patch');
  fs.writeFileSync(outsidePath, TEST_DIFF);

  const result = previewOpenCodeCandidatePatch({ rootDir, approval_id: approvalId, sandbox_root: sandboxRoot, candidate_patch_path: outsidePath });
  expect(result.ok).toBe(false);
  expect(result.reason).toBe('candidate_patch_path_not_allowed');
  expect(result.apply_allowed).toBe(false);
  expect(result.commands_executed).toEqual([]);
  expect(result.files_modified).toEqual([]);
});

test('/opencode-patch-preview handler returns non-apply preview summary', () => {
  const rootDir = makeRoot();
  const approvalId = 'APR-OPENCODE-PATCH-5';
  const { sandboxRoot, patchPath } = writeCandidatePatch(rootDir, approvalId, TEST_DIFF);
  const relativePatchPath = path.relative(rootDir, patchPath).replace(/\\/g, '/');

  const result = handleTelegramCommand(parseTelegramCommand(`/opencode-patch-preview ${approvalId} ${sandboxRoot} ${relativePatchPath}`), {
    rootDir,
    user_id: 3,
    roles: { owner_user_ids: [1], admin_user_ids: [2], reviewer_user_ids: [3], observer_user_ids: [4] }
  });

  expect(result.ok).toBe(true);
  expect(result.wired_to_runtime).toBe(false);
  expect(result.execution_connected).toBe(false);
  expect(result.apply_allowed).toBe(false);
  expect(result.summary.ok).toBe(true);
  expect(result.summary.apply_allowed).toBe(false);
  expect(result.summary.repository_files_modified).toEqual([]);
  expect(result.summary.commit_created).toBe(false);
  expect(result.summary.push_performed).toBe(false);
  expect(result.summary.deploy_performed).toBe(false);
  expect(result.summary.migration_performed).toBe(false);
  expect(result.text).toContain('OpenCode candidate patch preview ready. Patch apply remains disabled.');
});
