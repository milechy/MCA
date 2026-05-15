const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStory, readStory } = require('../../src/ralph/story-queue');
const { parseBool, parseArgs, daemonStatus, runDaemon } = require('../../scripts/ralph/autonomous-daemon');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-autonomous-daemon-'));
}

test('parseBool accepts explicit true only', () => {
  expect(parseBool(true)).toBe(true);
  expect(parseBool('true')).toBe(true);
  expect(parseBool('1')).toBe(false);
  expect(parseBool(false)).toBe(false);
});

test('parseArgs supports one-shot and bounded daemon options', () => {
  const options = parseArgs(['--once', '--interval-ms', '2000', '--max-cycles', '3', '--limit', '2', '--ticks-per-story', '4', '--root', '/tmp/root', '--pre-secret-scan-ok'], {});
  expect(options).toMatchObject({
    once: true,
    interval_ms: 2000,
    max_cycles: 3,
    limit: 2,
    ticks_per_story: 4,
    rootDir: '/tmp/root',
    pre_secret_scan_ok: true
  });
});

test('parseArgs supports pre-secret-scan flag through environment', () => {
  const options = parseArgs(['--once'], { RALPH_PRE_SECRET_SCAN_OK: 'true' });
  expect(options.pre_secret_scan_ok).toBe(true);
  const disabled = parseArgs(['--once'], { RALPH_PRE_SECRET_SCAN_OK: '1' });
  expect(disabled.pre_secret_scan_ok).toBe(false);
});

test('daemonStatus returns bounded cycle summary', () => {
  const status = daemonStatus(2, {
    ok: true,
    execution_connected: false,
    commands_executed: [],
    repository_files_modified: [],
    next_action: 'wait_for_runnable_story'
  }, { interval_ms: 1000, limit: 1, ticks_per_story: 1, pre_secret_scan_ok: true });
  expect(status).toMatchObject({
    ok: true,
    stage: 'ralph_autonomous_daemon_cycle',
    cycle: 2,
    interval_ms: 1000,
    limit: 1,
    ticks_per_story: 1,
    pre_secret_scan_ok: true,
    execution_connected: false,
    commands_executed: [],
    repository_files_modified: [],
    next_action: 'wait_for_runnable_story'
  });
});

test('runDaemon one-shot advances scheduler without repository mutation claims', async () => {
  const rootDir = tmpRoot();
  const created = createStory({ story_id: 'STORY-DAEMON', requirement: 'Add daemon test', mode: 'fullauto', target_env: 'local' }, { rootDir, now: new Date('2026-05-08T18:00:00.000Z') });
  expect(created.ok).toBe(true);

  const result = await runDaemon({ rootDir, once: true, interval_ms: 1000, max_cycles: 1, limit: 1, ticks_per_story: 1, pre_secret_scan_ok: true });

  expect(result).toMatchObject({
    ok: true,
    stage: 'ralph_autonomous_daemon',
    cycles: 1,
    stopped: false,
    execution_connected: false,
    commands_executed: [],
    repository_files_modified: [],
    next_action: 'daemon_completed_requested_cycles'
  });
  expect(result.outputs[0]).toMatchObject({ stage: 'ralph_autonomous_daemon_cycle', cycle: 1, pre_secret_scan_ok: true });
  expect(readStory(rootDir, 'STORY-DAEMON')).toMatchObject({ status: 'running', current_phase: 'OPENCODE_RUNNING' });
});

test('parseArgs picks up issue supplier options from env and flags', () => {
  const options = parseArgs(['--once', '--issue-pull-every-cycles', '15', '--issue-repo', 'owner/repo'], {
    RALPH_GITHUB_READY_LABELS: 'ralph-ready,autonomous',
    RALPH_ISSUE_PULL_MAX: '10'
  });
  expect(options).toMatchObject({
    issue_pull_every_cycles: 15,
    issue_repo: 'owner/repo',
    issue_ready_labels: ['ralph-ready', 'autonomous'],
    issue_max: 10
  });
});

test('parseArgs defaults issue_pull_every_cycles to 0 (off) when nothing configured', () => {
  expect(parseArgs(['--once'], {}).issue_pull_every_cycles).toBe(0);
});

test('daemonStatus surfaces a supplier summary when one is provided', () => {
  const status = daemonStatus(3, {
    ok: true,
    execution_connected: false,
    commands_executed: [],
    repository_files_modified: [],
    next_action: 'wait_for_runnable_story'
  }, { interval_ms: 1000, limit: 1, ticks_per_story: 1, pre_secret_scan_ok: true, issue_pull_every_cycles: 5 }, {
    ok: true,
    pulled: true,
    repo: 'owner/repo',
    summary: { imported_count: 2, skipped_count: 0 }
  });
  expect(status).toMatchObject({
    issue_pull_every_cycles: 5,
    issue_supplier: { ok: true, pulled: true, repo: 'owner/repo' }
  });
});

const { tryAcquireDaemonLock, releaseDaemonLock, DAEMON_LOCK_PATH_REL } = require('../../scripts/ralph/autonomous-daemon');

test('Phase 1 #11: tryAcquireDaemonLock writes the holder pid and refuses a second acquire while held', () => {
  // Bug H regression guard. Two daemons ticking the same .ralph/stories/ in
  // parallel produced cross-daemon races (e.g. one daemon's GATES rollback
  // unlinked a file the other daemon's COMMIT_APPROVAL preflight was about
  // to verify, surfacing as `applied_files_missing`). The lock makes this
  // impossible at the daemon-process boundary.
  const rootDir = tmpRoot();

  const first = tryAcquireDaemonLock(rootDir);
  expect(first.ok).toBe(true);
  expect(first.lock_path).toBe(DAEMON_LOCK_PATH_REL);

  const lockFile = path.join(rootDir, DAEMON_LOCK_PATH_REL);
  expect(fs.existsSync(lockFile)).toBe(true);
  const recorded = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  expect(recorded.pid).toBe(process.pid);
  expect(typeof recorded.acquired_at).toBe('string');

  const second = tryAcquireDaemonLock(rootDir);
  expect(second.ok).toBe(false);
  expect(second.reason).toBe('daemon_lock_held');
  expect(second.holder_pid).toBe(process.pid);

  releaseDaemonLock(rootDir);
  expect(fs.existsSync(lockFile)).toBe(false);

  // After release, a new acquire succeeds.
  const third = tryAcquireDaemonLock(rootDir);
  expect(third.ok).toBe(true);
  releaseDaemonLock(rootDir);
});

test('Phase 1 #11: tryAcquireDaemonLock recovers a stale lock whose pid is no longer alive', () => {
  const rootDir = tmpRoot();
  const lockPath = path.join(rootDir, DAEMON_LOCK_PATH_REL);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // Write a lock with a PID that's almost certainly not running (PID 1 is
  // root init on POSIX but on macOS we can't kill 0 it reliably from a
  // non-root context; use an obviously-dead PID instead).
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, acquired_at: '1990-01-01T00:00:00Z' }));

  const r = tryAcquireDaemonLock(rootDir);
  expect(r.ok).toBe(true);
  const recorded = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  expect(recorded.pid).toBe(process.pid);
  releaseDaemonLock(rootDir);
});

test('Phase 1 #11: releaseDaemonLock refuses to remove a lock held by a different pid', () => {
  const rootDir = tmpRoot();
  const lockPath = path.join(rootDir, DAEMON_LOCK_PATH_REL);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // Write a lock with another (still-alive) pid: this process's parent pid,
  // which is virtually always 1 or another live process.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, acquired_at: '2026-05-15T00:00:00Z' }));

  releaseDaemonLock(rootDir);
  // Other-pid lock is preserved.
  expect(fs.existsSync(lockPath)).toBe(true);
  // Clean up to avoid leaking into other tests.
  fs.unlinkSync(lockPath);
});
