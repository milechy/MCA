const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runSmoke } = require('../../scripts/ralph/autonomous-issue-to-pr-smoke');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-issue-to-pr-smoke-test-'));
}

test('fixture smoke reaches DONE without live push or PR side effects', () => {
  const rootDir = tmpRoot();
  const result = runSmoke({ fixture: true, stop_at: 'done', rootDir, keep_tmp: true });

  expect(result).toMatchObject({
    ok: true,
    reason: null,
    mode: 'fixture',
    story_id: 'STORY-SMOKE-ISSUE-PR',
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false,
    raw_logs_included: false,
    secrets_included: false,
    bounded_output: true,
    final_story: {
      story_id: 'STORY-SMOKE-ISSUE-PR',
      status: 'completed',
      current_phase: 'DONE',
      pr_url: 'https://github.com/milechy/MCA/pull/0',
      pr_number: 0
    },
    next_action: 'smoke_passed'
  });
  expect(result.repository_files_modified).toEqual([]);
  expect(result.transitions.map((entry) => entry.label)).toEqual([
    'issue_imported',
    'plan_approved_opencode_running',
    'candidate_patch_ready',
    'diff_approved_apply',
    'gates_passed',
    'commit_approved',
    'push_approval_pending',
    'push_resumed',
    'pr_approval_pending',
    'pr_resumed',
    'pr_created_done'
  ]);
  expect(result.transitions.at(-1)).toMatchObject({ phase: 'DONE', status: 'completed' });
  expect(result.final_dashboard_counts.completed).toBe(1);
});

test('fixture smoke can stop at push boundary', () => {
  const result = runSmoke({ fixture: true, stop_at: 'push', rootDir: tmpRoot() });

  expect(result).toMatchObject({
    ok: true,
    reason: 'stopped_at_push',
    next_action: 'stopped_at_push',
    final_story: {
      status: 'waiting_approval',
      current_phase: 'PR_APPROVAL_PENDING'
    },
    push_performed: false,
    pr_created: false
  });
  expect(result.transitions.map((entry) => entry.label)).toContain('pr_approval_pending');
  expect(result.transitions.map((entry) => entry.label)).not.toContain('pr_created_done');
});

test('github-live mode refuses without explicit environment gate', () => {
  const previous = process.env.RALPH_E2E_SMOKE_GITHUB_LIVE;
  delete process.env.RALPH_E2E_SMOKE_GITHUB_LIVE;
  try {
    const result = runSmoke({ github_live: true, fixture: false });
    expect(result).toMatchObject({
      ok: false,
      mode: 'github-live',
      reason: 'github_live_requires_RALPH_E2E_SMOKE_GITHUB_LIVE',
      next_action: 'set_explicit_live_gate_or_use_fixture'
    });
  } finally {
    if (previous === undefined) delete process.env.RALPH_E2E_SMOKE_GITHUB_LIVE;
    else process.env.RALPH_E2E_SMOKE_GITHUB_LIVE = previous;
  }
});
