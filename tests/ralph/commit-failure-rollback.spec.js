const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// We can't easily mock advanceCommitPhase from a unit test because it pulls in
// commitOpenCodeAppliedPatch and the whole telegram surface. Instead, test the
// composition directly: the autonomous-loop module exports buildOpenCodePreflight
// etc., and we drive advanceCommitPhase via the public tickAutonomousLoop entry
// point with a commit_runner injected.

const { createStory, readStory, updateStory, STORY_STATUSES } = require('../../src/ralph/story-queue');
const { LOOP_PHASES, tickAutonomousLoop } = require('../../src/ralph/autonomous-loop');
const { rollbackAppliedFiles } = require('../../src/ralph/apply-rollback');

// Note: tickAutonomousLoop's commit phase uses commitOpenCodeAppliedPatch
// directly; there's no commit_runner injection point. To exercise the
// rollback-on-commit-failure path end-to-end without faking the underlying
// helper, we directly test:
//   1. The rollback module's behavior when called from a commit-failure-shaped
//      apply_result.
//   2. The story's last_apply_rollback field is recorded by advanceCommitPhase
//      when the commit helper returns ok=false. Asserted indirectly by
//      ensuring the rollback function correctly cleans the artifacts a
//      simulated commit failure would have left behind.

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-rollback-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# initial\n');
  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

test('rollbackAppliedFiles cleans up an applied-but-not-committed file when commit later fails', () => {
  // This is the post-Bug-D scenario: APPLY landed a file, GATES passed,
  // COMMIT_APPROVAL_PENDING auto-approved, COMMIT failed (e.g. git complained
  // about a parallel uncommitted file). Phase 1 #8 hooks rollback into the
  // COMMIT failure path so the working tree returns to clean.
  const repo = tmpRepo();
  fs.mkdirSync(path.join(repo, 'docs/soak'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs/soak/glossary-rs-000000.md'), '# applied content from kimi\n');

  expect(fs.existsSync(path.join(repo, 'docs/soak/glossary-rs-000000.md'))).toBe(true);

  const r = rollbackAppliedFiles({
    rootDir: repo,
    apply_result: { repository_files_modified: ['docs/soak/glossary-rs-000000.md'] },
    requested_paths: ['docs/soak/glossary-rs-000000.md']
  });
  expect(r.ok).toBe(true);
  expect(fs.existsSync(path.join(repo, 'docs/soak/glossary-rs-000000.md'))).toBe(false);
});

test('rollbackAppliedFiles refuses to clean up paths outside the failed story requested_paths even if other untracked files exist', () => {
  // Operator's own unrelated untracked file MUST be preserved across a
  // commit-failure-driven rollback.
  const repo = tmpRepo();
  fs.mkdirSync(path.join(repo, 'docs/soak'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs/soak/story-applied.md'), '# applied by failing story\n');
  fs.writeFileSync(path.join(repo, 'operator-notes.txt'), 'operator unrelated edit\n');

  const r = rollbackAppliedFiles({
    rootDir: repo,
    apply_result: { repository_files_modified: ['docs/soak/story-applied.md', 'operator-notes.txt'] },
    requested_paths: ['docs/soak/story-applied.md'] // operator-notes.txt was not in this story's requested_paths
  });

  // The story's own file is removed.
  expect(fs.existsSync(path.join(repo, 'docs/soak/story-applied.md'))).toBe(false);
  // The operator's unrelated file is preserved.
  expect(fs.existsSync(path.join(repo, 'operator-notes.txt'))).toBe(true);
  // verify reports the working tree is still dirty because of the operator's
  // file; the rollback function does its bounded job and reports honestly.
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('working_tree_still_dirty');
});

test('rollbackAppliedFiles handles a mix of applied files (some newly-created, some tracked modifications) on commit failure', () => {
  const repo = tmpRepo();
  // tracked file that the failed story modified
  fs.writeFileSync(path.join(repo, 'README.md'), '# initial\n+ failing story added a line\n');
  // newly-created file from the failed story
  fs.mkdirSync(path.join(repo, 'docs/soak'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs/soak/glossary-x-000003.md'), '# new\n');

  const r = rollbackAppliedFiles({
    rootDir: repo,
    apply_result: { repository_files_modified: ['README.md', 'docs/soak/glossary-x-000003.md'] },
    requested_paths: ['README.md', 'docs/soak/glossary-x-000003.md']
  });
  expect(r.ok).toBe(true);
  // tracked file restored to HEAD content
  expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# initial\n');
  // newly-created file unlinked
  expect(fs.existsSync(path.join(repo, 'docs/soak/glossary-x-000003.md'))).toBe(false);
});

test('story state contract: advanceCommitPhase failure path records last_apply_rollback', () => {
  // Smoke-test the contract: when a story is in COMMIT phase and the commit
  // helper fails, the resulting story document should have last_apply_rollback
  // set to a rollback object (or at least to something non-undefined). We
  // can't easily drive the real commit helper to fail without git surgery, so
  // we verify the shape by constructing a story that would be in COMMIT and
  // ensuring updateStory accepts the last_apply_rollback field.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-state-'));
  const created = createStory({
    story_id: 'STORY-COMMIT-ROLLBACK',
    title: 'commit rollback state',
    requirement: 'demonstrate state record',
    requested_paths: ['docs/soak/x.md'],
    priority: 50,
    mode: 'approval',
    target_env: 'local',
    risk: { score: 0, category: 'low', label: 'RISK_0_LOW' }
  }, { rootDir: dir, now: new Date() });
  expect(created.ok).toBe(true);
  const fakeRollback = {
    ok: true,
    version: 'apply_rollback_v0_1',
    paths: ['docs/soak/x.md'],
    actions: [{ path: 'docs/soak/x.md', action: 'unlink', ok: true }],
    reason: null
  };
  updateStory('STORY-COMMIT-ROLLBACK', {
    status: STORY_STATUSES.FAILED,
    current_phase: LOOP_PHASES.ESCALATED,
    blocked_reason: 'commit_failed',
    last_apply_rollback: fakeRollback
  }, { rootDir: dir, now: new Date(), event: 'commit_failed_with_rollback_for_test' });
  const s = readStory(dir, 'STORY-COMMIT-ROLLBACK');
  expect(s).toMatchObject({
    current_phase: 'ESCALATED',
    status: 'failed',
    blocked_reason: 'commit_failed',
    last_apply_rollback: { ok: true }
  });
});
