const { test, expect } = require('@playwright/test');

const {
  buildPrBody,
  normalizeChangedFiles,
  normalizeApprovals,
  normalizeGateSummary,
  buildSafetyChecklist,
  redactText
} = require('../../src/ralph/pr-body-generator');

function fakeGitHubToken() {
  return ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz'].join('');
}

test('buildPrBody generates bounded PR body from story, UltraPlan, files, gates, approvals and hashes', () => {
  const result = buildPrBody({
    story: {
      story_id: 'STORY-GH-12',
      title: 'Implement PR body generator',
      requirement: 'Generate a safe PR body for Ralph autonomous changes.',
      acceptance_criteria: ['Includes safety checklist.', 'Includes gate summary.'],
      current_plan_hash: 'sha256:planhash'
    },
    ultraplan: {
      tasks: [
        { id: 'TASK-001', title: 'Implement generator' },
        { id: 'TASK-002', objective: 'Add tests' }
      ],
      acceptance_criteria: ['fallback acceptance']
    },
    changed_files: ['src/ralph/pr-body-generator.js', { filename: 'tests/ralph/pr-body-generator.spec.js' }],
    gates: {
      ok: true,
      gates: [
        { id: 'ralph-tests', ok: true, required: true },
        { id: 'post-secret-scan', ok: true, required: true }
      ]
    },
    approvals: [
      { approval_id: 'APR-DIFF-1', approval_type: 'diff', status: 'approved', approved_by: 'telegram:123', plan_hash: 'sha256:planhash', post_exec_diff_hash: 'sha256:diffhash' },
      'APR-COMMIT-1'
    ]
  });

  expect(result).toMatchObject({
    ok: true,
    stage: 'pr_body_generator',
    title: 'Implement PR body generator',
    plan_hash: 'sha256:planhash',
    diff_hash: 'sha256:diffhash',
    execution_connected: false,
    commands_executed: [],
    repository_files_modified: [],
    next_action: 'review_pr_body_before_pr_creation'
  });
  expect(result.body).toContain('## Summary');
  expect(result.body).toContain('STORY-GH-12');
  expect(result.body).toContain('`src/ralph/pr-body-generator.js`');
  expect(result.body).toContain('PASS ralph-tests');
  expect(result.body).toContain('APR-DIFF-1');
  expect(result.body).toContain('sha256:planhash');
  expect(result.body).toContain('sha256:diffhash');
  expect(result.body).toContain('No raw logs or secrets included');
});

test('buildPrBody redacts secrets, token-shaped strings, and emails from output', () => {
  const tokenFixture = fakeGitHubToken();
  const emailFixture = ['dev', 'example.com'].join('@');
  const result = buildPrBody({
    story: {
      story_id: 'STORY-SECRET',
      title: `Do not leak ${tokenFixture}`,
      requirement: `password: hunter2 Contact ${emailFixture}`,
      acceptance_criteria: [`token=${tokenFixture}`]
    },
    changed_files: [`src/${tokenFixture}.js`],
    gates: { ok: false, gates: [{ id: 'post-secret-scan', ok: false, reason: `secret: hunter2 ${emailFixture}` }] },
    approvals: [{ approval_id: `APR-${tokenFixture}`, status: 'approved', approved_by: emailFixture }],
    plan_hash: tokenFixture,
    diff_hash: `secret=${tokenFixture}`
  });

  expect(result.body).not.toContain(tokenFixture);
  expect(result.body).not.toContain('hunter2');
  expect(result.body).not.toContain(emailFixture);
  expect(JSON.stringify(result)).not.toContain(emailFixture);
});

test('normalizers bound changed files, approvals, and gates', () => {
  const files = normalizeChangedFiles(Array.from({ length: 60 }, (_, index) => `src/file-${index}.js`));
  const approvals = normalizeApprovals(Array.from({ length: 30 }, (_, index) => ({ approval_id: `APR-${index}`, status: 'approved' })));
  const gates = normalizeGateSummary({ gates: Array.from({ length: 30 }, (_, index) => ({ id: `gate-${index}`, ok: true })) });

  expect(files).toHaveLength(50);
  expect(approvals).toHaveLength(20);
  expect(gates).toHaveLength(20);
});

test('buildSafetyChecklist includes required Ralph safety lines', () => {
  const checklist = buildSafetyChecklist().join('\n');
  expect(checklist).toContain('No production deploy from Telegram');
  expect(checklist).toContain('No production migration from Telegram');
  expect(checklist).toContain('No merge from Telegram');
  expect(checklist).toContain('No unrestricted shell');
  expect(checklist).toContain('No raw logs or secrets included');
  expect(checklist).toContain('No default branch direct mutation without approval path');
});

test('buildPrBody handles missing optional sections with safe placeholders', () => {
  const result = buildPrBody({ story: { story_id: 'STORY-MIN', title: 'Minimal' } });
  expect(result.body).toContain('No task summary available.');
  expect(result.body).toContain('No changed file list provided.');
  expect(result.body).toContain('Approval records not provided');
  expect(result.plan_hash).toBe('not_available');
  expect(result.diff_hash).toBe('not_available');
});

test('redactText removes common secret-shaped values', () => {
  const tokenFixture = fakeGitHubToken();
  const emailFixture = ['root', 'example.com'].join('@');
  const text = redactText(`api_key=abc123 password: hunter2 ${emailFixture} ${tokenFixture}`);
  expect(text).not.toContain('hunter2');
  expect(text).not.toContain(emailFixture);
  expect(text).not.toContain(tokenFixture);
});
