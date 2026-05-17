const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  PROMOTE_VERSION,
  normalizeBranchSegment,
  featureBranchForStory,
  currentBranch,
  revParse,
  refExists,
  promoteCommitToFeatureBranch
} = require('../../src/ralph/feature-branch-promote');

function tmpRepo(branch = 'infra/phase0-autonomous-foundation') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-branch-promote-'));
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'ralph@example.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Ralph'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# initial\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

function makeSecondCommit(rootDir) {
  fs.writeFileSync(path.join(rootDir, 'docs.md'), '# second commit content\n');
  execFileSync('git', ['add', '.'], { cwd: rootDir });
  execFileSync('git', ['commit', '-q', '-m', 'second commit (will be promoted off trunk)'], { cwd: rootDir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim();
}

test('featureBranchForStory derives a safe branch name from a story id', () => {
  expect(featureBranchForStory('STORY-SOAK-20260517020236-000033')).toBe('auto/STORY-SOAK-20260517020236-000033');
  expect(featureBranchForStory('story with spaces and !@# chars')).toBe('auto/story-with-spaces-and-chars');
  expect(featureBranchForStory('')).toBe(null);
  expect(featureBranchForStory(null)).toBe(null);
});

test('normalizeBranchSegment removes unsafe chars and collapses repeats', () => {
  expect(normalizeBranchSegment('---x---y---')).toBe('x-y');
  expect(normalizeBranchSegment('STORY!!!ABC')).toBe('STORY-ABC');
  expect(normalizeBranchSegment('a/b/c')).toBe('a/b/c'); // slashes preserved (valid in git refs)
  expect(normalizeBranchSegment('')).toBe('');
});

test('promoteCommitToFeatureBranch rewinds trunk to the commit parent and creates the feature branch at the commit', () => {
  const rootDir = tmpRepo();
  const trunkBefore = revParse(rootDir, 'HEAD');
  const commitSha = makeSecondCommit(rootDir);
  // pre-condition: HEAD is on the trunk branch and == commitSha
  expect(currentBranch(rootDir)).toBe('infra/phase0-autonomous-foundation');
  expect(revParse(rootDir, 'HEAD')).toBe(commitSha);
  expect(revParse(rootDir, 'infra/phase0-autonomous-foundation')).toBe(commitSha);

  const r = promoteCommitToFeatureBranch({
    rootDir,
    story_id: 'STORY-PROMOTE-001',
    commit_sha: commitSha,
    trunk_branch: 'infra/phase0-autonomous-foundation'
  });

  expect(r.ok).toBe(true);
  expect(r.reason).toBe(null);
  expect(r.feature_branch).toBe('auto/STORY-PROMOTE-001');
  expect(r.trunk_branch).toBe('infra/phase0-autonomous-foundation');
  expect(r.commit_sha).toBe(commitSha);
  expect(r.parent_sha).toBe(trunkBefore);

  // Post-condition: trunk was rewound to its prior tip.
  expect(revParse(rootDir, 'infra/phase0-autonomous-foundation')).toBe(trunkBefore);
  // The feature branch points at the promoted commit.
  expect(revParse(rootDir, 'auto/STORY-PROMOTE-001')).toBe(commitSha);
  // Working tree is clean (git reset --hard).
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: rootDir, encoding: 'utf8' });
  expect(status.stdout.trim()).toBe('');
  // The promoted file no longer exists in the working tree (since we rewound).
  expect(fs.existsSync(path.join(rootDir, 'docs.md'))).toBe(false);
});

test('promoteCommitToFeatureBranch refuses when HEAD is not the commit_sha (precondition violation)', () => {
  const rootDir = tmpRepo();
  const realCommit = makeSecondCommit(rootDir);
  const wrongSha = '0123456789abcdef0123456789abcdef01234567';

  const r = promoteCommitToFeatureBranch({
    rootDir,
    story_id: 'STORY-PROMOTE-WRONG-SHA',
    commit_sha: wrongSha,
    trunk_branch: 'infra/phase0-autonomous-foundation'
  });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('head_is_not_commit_sha');
  expect(r.head).toBe(realCommit);
  expect(r.commit_sha).toBe(wrongSha);
});

test('promoteCommitToFeatureBranch refuses when current branch is not the declared trunk', () => {
  const rootDir = tmpRepo();
  const commitSha = makeSecondCommit(rootDir);

  const r = promoteCommitToFeatureBranch({
    rootDir,
    story_id: 'STORY-PROMOTE-WRONG-TRUNK',
    commit_sha: commitSha,
    trunk_branch: 'some-other-branch'
  });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('current_branch_is_not_trunk');
  expect(r.current_branch).toBe('infra/phase0-autonomous-foundation');
  expect(r.trunk_branch).toBe('some-other-branch');
});

test('promoteCommitToFeatureBranch refuses to overwrite an existing feature branch pointing elsewhere', () => {
  const rootDir = tmpRepo();
  const commitSha = makeSecondCommit(rootDir);

  // Pre-create the target branch at a different SHA (the parent).
  const parentSha = execFileSync('git', ['rev-parse', `${commitSha}^`], { cwd: rootDir, encoding: 'utf8' }).trim();
  execFileSync('git', ['branch', 'auto/STORY-PROMOTE-COLLIDE', parentSha], { cwd: rootDir });

  const r = promoteCommitToFeatureBranch({
    rootDir,
    story_id: 'STORY-PROMOTE-COLLIDE',
    commit_sha: commitSha,
    trunk_branch: 'infra/phase0-autonomous-foundation'
  });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('feature_branch_already_exists');
  expect(r.existing_sha).toBe(parentSha);
  expect(r.commit_sha).toBe(commitSha);
  // Trunk must NOT have been rewound.
  expect(revParse(rootDir, 'infra/phase0-autonomous-foundation')).toBe(commitSha);
});

test('promoteCommitToFeatureBranch is idempotent when the feature branch already points at the same commit', () => {
  const rootDir = tmpRepo();
  const commitSha = makeSecondCommit(rootDir);

  // Pre-create the branch at the right SHA (simulating an interrupted re-run).
  execFileSync('git', ['branch', 'auto/STORY-PROMOTE-IDEMPOTENT', commitSha], { cwd: rootDir });

  const r = promoteCommitToFeatureBranch({
    rootDir,
    story_id: 'STORY-PROMOTE-IDEMPOTENT',
    commit_sha: commitSha,
    trunk_branch: 'infra/phase0-autonomous-foundation'
  });
  expect(r.ok).toBe(true);
  expect(r.feature_branch).toBe('auto/STORY-PROMOTE-IDEMPOTENT');
  expect(revParse(rootDir, 'auto/STORY-PROMOTE-IDEMPOTENT')).toBe(commitSha);
});

test('promoteCommitToFeatureBranch rejects invalid inputs cleanly', () => {
  const rootDir = tmpRepo();
  expect(promoteCommitToFeatureBranch({}).reason).toBe('root_dir_required');
  expect(promoteCommitToFeatureBranch({ rootDir, story_id: '', commit_sha: 'a'.repeat(40), trunk_branch: 'main' }).reason).toBe('feature_branch_invalid');
  expect(promoteCommitToFeatureBranch({ rootDir, story_id: 'X', commit_sha: 'not-a-sha', trunk_branch: 'main' }).reason).toBe('commit_sha_invalid');
  expect(promoteCommitToFeatureBranch({ rootDir, story_id: 'X', commit_sha: 'a'.repeat(40), trunk_branch: 'has spaces' }).reason).toBe('trunk_branch_invalid');
});

test('PROMOTE_VERSION is stable for downstream consumers', () => {
  expect(PROMOTE_VERSION).toBe('feature_branch_promote_v0_1');
});

test('refExists detects local refs', () => {
  const rootDir = tmpRepo();
  expect(refExists(rootDir, 'refs/heads/infra/phase0-autonomous-foundation')).toBe(true);
  expect(refExists(rootDir, 'refs/heads/does-not-exist')).toBe(false);
});
