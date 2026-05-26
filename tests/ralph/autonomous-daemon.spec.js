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

// ============================================================
// Phase 2 #5.x: daemon budget guard tests
// ============================================================

const { evaluateBudgetGuard } = require('../../scripts/ralph/autonomous-daemon');
const fsForBudget = require('node:fs');
const osForBudget = require('node:os');
const pathForBudget = require('node:path');

function budgetTmpRoot() {
  return fsForBudget.mkdtempSync(pathForBudget.join(osForBudget.tmpdir(), 'daemon-budget-guard-'));
}

function writeCostLedger(rootDir, entries) {
  fsForBudget.mkdirSync(pathForBudget.join(rootDir, '.ralph'), { recursive: true });
  const ledgerPath = pathForBudget.join(rootDir, '.ralph', 'cost-ledger.jsonl');
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fsForBudget.writeFileSync(ledgerPath, lines, 'utf8');
}

test('Phase 2 #5.x: evaluateBudgetGuard returns paused=false when spend is under cap', () => {
  const rootDir = budgetTmpRoot();
  writeCostLedger(rootDir, [{
    at: new Date().toISOString(),
    story_id: 'STORY-A',
    model: 'kimi',
    input_tokens: 100,
    output_tokens: 100,
    cost_usd: 0.0001
  }]);
  const guard = evaluateBudgetGuard({
    rootDir,
    env: { RALPH_KIMI_DAILY_BUDGET_USD: '5.00' }
  });
  expect(guard.paused).toBe(false);
  expect(guard.over).toBe(false);
  expect(guard.daily_cap).toBe(5.00);
  expect(guard.daily_spend).toBe(0.0001);
});

test('Phase 2 #5.x: evaluateBudgetGuard returns paused=true when spend exceeds cap', () => {
  const rootDir = budgetTmpRoot();
  writeCostLedger(rootDir, [{
    at: new Date().toISOString(),
    story_id: 'STORY-EXPENSIVE',
    model: 'kimi',
    input_tokens: 999999,
    output_tokens: 999999,
    cost_usd: 100.0
  }]);
  const guard = evaluateBudgetGuard({
    rootDir,
    env: { RALPH_KIMI_DAILY_BUDGET_USD: '0.01' }
  });
  expect(guard.paused).toBe(true);
  expect(guard.over).toBe(true);
  expect(guard.reason).toBe('daily_budget_exceeded');
});

test('Phase 2 #5.x: evaluateBudgetGuard with skip=true bypasses the check', () => {
  const rootDir = budgetTmpRoot();
  writeCostLedger(rootDir, [{
    at: new Date().toISOString(),
    story_id: 'STORY-EXPENSIVE',
    model: 'kimi',
    input_tokens: 999999,
    output_tokens: 999999,
    cost_usd: 100.0
  }]);
  const guard = evaluateBudgetGuard({
    rootDir,
    env: { RALPH_KIMI_DAILY_BUDGET_USD: '0.01' },
    skip: true
  });
  expect(guard.paused).toBe(false);
  expect(guard.reason).toBe('budget_guard_skipped');
});

test('Phase 2 #5.x: evaluateBudgetGuard handles missing ledger gracefully (no spend yet)', () => {
  const rootDir = budgetTmpRoot();
  // No ledger file at all
  const guard = evaluateBudgetGuard({
    rootDir,
    env: { RALPH_KIMI_DAILY_BUDGET_USD: '5.00' }
  });
  expect(guard.paused).toBe(false);
  expect(guard.daily_spend).toBe(0);
});

test('Phase 2 #5.x: parseArgs picks up --skip-budget-guard from flag and env', () => {
  const opts1 = parseArgs(['--skip-budget-guard'], {});
  expect(opts1.skip_budget_guard).toBe(true);
  const opts2 = parseArgs([], { RALPH_DAEMON_SKIP_BUDGET_GUARD: 'true' });
  expect(opts2.skip_budget_guard).toBe(true);
  const opts3 = parseArgs([], {});
  expect(opts3.skip_budget_guard).toBe(false);
});

test('Phase 2 #5.x: daemonStatus includes the budget object when provided', () => {
  const status = daemonStatus(1, {
    ok: true, stage: 's', execution_connected: false, commands_executed: [], repository_files_modified: [], next_action: 'n'
  }, { interval_ms: 60000, limit: 1, ticks_per_story: 1, pre_secret_scan_ok: false }, null, {
    paused: false, reason: null, over: false, daily_spend: 0.42, daily_cap: 5.0, fraction: 0.084
  });
  expect(status.budget).toMatchObject({ paused: false, daily_spend: 0.42, daily_cap: 5.0 });
});

test('Phase 2 #5.x: runDaemon emits budget_paused status without invoking scheduler when over budget', async () => {
  // End-to-end: write a ledger that exceeds an artificially-low cap, run
  // one daemon cycle, assert no scheduler run happened.
  const rootDir = budgetTmpRoot();
  writeCostLedger(rootDir, [{
    at: new Date().toISOString(),
    story_id: 'STORY-OVER',
    model: 'kimi',
    input_tokens: 999999,
    output_tokens: 999999,
    cost_usd: 50.0
  }]);
  const prevCap = process.env.RALPH_KIMI_DAILY_BUDGET_USD;
  process.env.RALPH_KIMI_DAILY_BUDGET_USD = '0.01';
  try {
    const result = await runDaemon({
      rootDir,
      once: true,
      interval_ms: 1000,
      max_cycles: 1,
      limit: 1,
      ticks_per_story: 1,
      pre_secret_scan_ok: true,
      issue_pull_every_cycles: 0,
      skip_budget_guard: false
    });
    expect(result.outputs.length).toBeGreaterThanOrEqual(1);
    const firstStatus = result.outputs[0];
    expect(firstStatus.budget.paused).toBe(true);
    expect(firstStatus.scheduler.stage).toBe('ralph_autonomous_daemon_budget_paused');
    expect(firstStatus.scheduler.reason).toBe('daily_budget_exceeded');
  } finally {
    if (prevCap === undefined) delete process.env.RALPH_KIMI_DAILY_BUDGET_USD;
    else process.env.RALPH_KIMI_DAILY_BUDGET_USD = prevCap;
  }
});

test('Phase 6 #2: daemonStatus includes watchdog field when provided', () => {
  const status = daemonStatus(1, {
    ok: true, stage: 's', execution_connected: false, commands_executed: [], repository_files_modified: [], next_action: 'n'
  }, { interval_ms: 60000, limit: 1, ticks_per_story: 1, pre_secret_scan_ok: false }, null, null, {
    ok: true, stuck: [{ story_id: 'STUCK-1', current_phase: 'OPENCODE_RUNNING', status: 'running', cycles_in_phase: 7, suggested_action: 'restart_dispatch' }], mode_expired_blocking: false, checked_at: new Date().toISOString()
  });
  expect(status.watchdog).toMatchObject({ ok: true, stuck: [{ story_id: 'STUCK-1' }], mode_expired_blocking: false });
});

test('Phase 6 #2: runDaemon includes watchdog in cycle output when enabled', async () => {
  const rootDir = tmpRoot();
  const created = createStory({ story_id: 'STORY-WATCHDOG', requirement: 'Watchdog test', mode: 'fullauto', target_env: 'local' }, { rootDir, now: new Date('2026-05-08T18:00:00.000Z') });
  expect(created.ok).toBe(true);

  const result = await runDaemon({ rootDir, once: true, interval_ms: 1000, max_cycles: 1, limit: 1, ticks_per_story: 1, pre_secret_scan_ok: true });
  expect(result.outputs.length).toBeGreaterThanOrEqual(1);
  const firstStatus = result.outputs[0];
  expect(firstStatus).toHaveProperty('watchdog');
  expect(firstStatus.watchdog).toMatchObject({ ok: true, stuck: expect.any(Array), mode_expired_blocking: expect.any(Boolean) });
});

test('Phase 6 #2: runDaemon skips watchdog when RALPH_WATCHDOG_ENABLED=0', async () => {
  const rootDir = tmpRoot();
  const created = createStory({ story_id: 'STORY-NO-WATCHDOG', requirement: 'No watchdog test', mode: 'fullauto', target_env: 'local' }, { rootDir, now: new Date('2026-05-08T18:00:00.000Z') });
  expect(created.ok).toBe(true);

  const prev = process.env.RALPH_WATCHDOG_ENABLED;
  process.env.RALPH_WATCHDOG_ENABLED = '0';
  try {
    const result = await runDaemon({ rootDir, once: true, interval_ms: 1000, max_cycles: 1, limit: 1, ticks_per_story: 1, pre_secret_scan_ok: true });
    expect(result.outputs.length).toBeGreaterThanOrEqual(1);
    const firstStatus = result.outputs[0];
    expect(firstStatus.watchdog).toBeNull();
  } finally {
    if (prev === undefined) delete process.env.RALPH_WATCHDOG_ENABLED;
    else process.env.RALPH_WATCHDOG_ENABLED = prev;
  }
});
