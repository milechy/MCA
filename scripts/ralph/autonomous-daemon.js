#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { schedulerTick } = require('../../src/ralph/autonomous-scheduler');
const { isOverBudget } = require('../../src/ralph/kimi-cost-tracker');
const { detectStuckStories } = require('../../src/ralph/stuck-watchdog');
const { tickIssueSupplier, supplierOptionsFromEnv } = require('../../src/ralph/github-issue-supplier');

function parseBool(value) {
  return value === true || value === 'true';
}

// Phase 1 #11: refuse to start a second concurrent daemon against the same
// rootDir. Two daemons ticking the same .ralph/stories/ directory in
// parallel produced cross-daemon races where one daemon's Phase 1 #7 GATES
// rollback removed files that the other daemon's COMMIT_APPROVAL preflight
// was about to verify — surfacing as applied_files_missing in the soak.
const DAEMON_LOCK_PATH_REL = '.ralph/locks/autonomous-daemon.lock';

function tryAcquireDaemonLock(rootDir) {
  const lockPath = path.join(rootDir, DAEMON_LOCK_PATH_REL);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // Atomic create-only open: fails if the file already exists.
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') {
      // Stale-lock recovery: if the PID inside is no longer alive, take over.
      let stalePid = null;
      try {
        const content = fs.readFileSync(lockPath, 'utf8');
        const parsed = JSON.parse(content);
        stalePid = Number.parseInt(parsed.pid, 10);
      } catch { /* ignore */ }
      if (Number.isInteger(stalePid) && stalePid > 0 && !pidIsAlive(stalePid)) {
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
        return tryAcquireDaemonLock(rootDir);
      }
      return { ok: false, reason: 'daemon_lock_held', lock_path: DAEMON_LOCK_PATH_REL, holder_pid: stalePid };
    }
    return { ok: false, reason: 'daemon_lock_create_failed', error: String(error && error.message || error) };
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
  } finally {
    fs.closeSync(fd);
  }
  return { ok: true, lock_path: DAEMON_LOCK_PATH_REL };
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function releaseDaemonLock(rootDir) {
  const lockPath = path.join(rootDir, DAEMON_LOCK_PATH_REL);
  try {
    const content = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(content);
    if (Number.parseInt(parsed.pid, 10) === process.pid) fs.unlinkSync(lockPath);
  } catch { /* ignore */ }
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const value = (name, fallback = undefined) => {
    const index = argv.indexOf(name);
    if (index === -1) return fallback;
    return argv[index + 1];
  };
  const has = (name) => argv.includes(name);
  const intervalMs = Number.parseInt(value('--interval-ms', env.RALPH_DAEMON_INTERVAL_MS || '60000'), 10);
  const maxCycles = Number.parseInt(value('--max-cycles', env.RALPH_DAEMON_MAX_CYCLES || (has('--once') ? '1' : '0')), 10);
  const limit = Number.parseInt(value('--limit', env.RALPH_DAEMON_LIMIT || '1'), 10);
  const ticksPerStory = Number.parseInt(value('--ticks-per-story', env.RALPH_DAEMON_TICKS_PER_STORY || '1'), 10);
  const preSecretScanOk = has('--pre-secret-scan-ok') || parseBool(value('--pre-secret-scan-ok', env.RALPH_PRE_SECRET_SCAN_OK));
  const supplierFromEnv = supplierOptionsFromEnv(env);
  const issuePullEvery = Number.parseInt(value('--issue-pull-every-cycles', `${supplierFromEnv.pull_every_cycles}`), 10);
  return {
    once: has('--once'),
    interval_ms: Number.isFinite(intervalMs) && intervalMs >= 1000 ? Math.min(intervalMs, 3600000) : 60000,
    max_cycles: Number.isFinite(maxCycles) && maxCycles >= 0 ? Math.min(maxCycles, 1000000) : 0,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 25) : 1,
    ticks_per_story: Number.isFinite(ticksPerStory) && ticksPerStory > 0 ? Math.min(ticksPerStory, 12) : 1,
    rootDir: value('--root', process.cwd()),
    pre_secret_scan_ok: preSecretScanOk,
    issue_pull_every_cycles: Number.isFinite(issuePullEvery) && issuePullEvery >= 0 ? issuePullEvery : 0,
    issue_repo: value('--issue-repo', supplierFromEnv.repo),
    issue_ready_labels: supplierFromEnv.ready_labels,
    issue_max: supplierFromEnv.max_issues,
    // Phase 2 #5.x: budget guard CLI flag. Default OFF (i.e., guard ON).
    // Set RALPH_DAEMON_SKIP_BUDGET_GUARD=true or pass --skip-budget-guard to bypass.
    skip_budget_guard: has('--skip-budget-guard') || parseBool(value('--skip-budget-guard', env.RALPH_DAEMON_SKIP_BUDGET_GUARD))
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function daemonStatus(cycle, result, options, supplier = null, budget = null, watchdog = null) {
  return {
    ok: result.ok === true && (supplier === null || supplier.ok === true),
    stage: 'ralph_autonomous_daemon_cycle',
    cycle,
    interval_ms: options.interval_ms,
    limit: options.limit,
    ticks_per_story: options.ticks_per_story,
    pre_secret_scan_ok: options.pre_secret_scan_ok === true,
    issue_pull_every_cycles: options.issue_pull_every_cycles || 0,
    issue_supplier: supplier,
    budget,
    scheduler: result,
    watchdog,
    execution_connected: result.execution_connected === true,
    commands_executed: result.commands_executed || [],
    repository_files_modified: result.repository_files_modified || [],
    next_action: result.next_action
  };
}

// Phase 2 #5.x: daemon-level budget guard.
//
// Before each scheduler tick, consult kimi-cost-tracker.isOverBudget to see
// whether today's Kimi spend has exceeded the configured daily cap. When
// over budget, the daemon SKIPS the scheduler tick (no new stories started)
// and emits a paused status. The daemon continues running so it can resume
// automatically (a) when the user adds OpenRouter credit + the call cost
// estimates fall back under the cap, or more commonly (b) when the date
// rolls over and the new daily window starts fresh.
//
// CLI: --skip-budget-guard disables the check (testing / one-off forced run).
function evaluateBudgetGuard({ rootDir, env = process.env, skip = false, now = new Date() }) {
  if (skip) {
    return { paused: false, reason: 'budget_guard_skipped', over: false, daily_spend: 0, daily_cap: 0, fraction: 0 };
  }
  try {
    const result = isOverBudget({ rootDir, env, now });
    return {
      paused: result.over === true,
      reason: result.over ? 'daily_budget_exceeded' : null,
      over: result.over === true,
      daily_spend: result.daily_spend,
      daily_cap: result.daily_cap,
      fraction: result.fraction
    };
  } catch (error) {
    // Best-effort: a failure in the budget tracker must not crash the daemon.
    return {
      paused: false,
      reason: `budget_guard_error:${String(error && error.message ? error.message : error).slice(0, 80)}`,
      over: false,
      daily_spend: 0,
      daily_cap: 0,
      fraction: 0
    };
  }
}

async function runDaemon(options = parseArgs()) {
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once?.('SIGINT', stop);
  process.once?.('SIGTERM', stop);

  const lock = tryAcquireDaemonLock(options.rootDir);
  if (!lock.ok) {
    console.error(JSON.stringify({ ok: false, stage: 'ralph_autonomous_daemon', reason: lock.reason, holder_pid: lock.holder_pid || null, lock_path: lock.lock_path }, null, 2));
    return { ok: false, stage: 'ralph_autonomous_daemon', reason: lock.reason, holder_pid: lock.holder_pid || null, cycles: 0, stopped: true, outputs: [], next_action: 'kill_other_daemon_or_remove_stale_lock' };
  }
  const releaseLockOnExit = () => releaseDaemonLock(options.rootDir);
  process.once?.('SIGINT', releaseLockOnExit);
  process.once?.('SIGTERM', releaseLockOnExit);
  process.once?.('exit', releaseLockOnExit);

  const outputs = [];
  let cycle = 0;
  while (!stopped) {
    cycle += 1;
    const now = new Date();
    let supplier = null;
    if (options.issue_pull_every_cycles && options.issue_pull_every_cycles > 0) {
      supplier = await tickIssueSupplier({
        cycle,
        env: process.env,
        rootDir: options.rootDir,
        now,
        options: {
          pull_every_cycles: options.issue_pull_every_cycles,
          repo: options.issue_repo || null,
          ready_labels: options.issue_ready_labels,
          max_issues: options.issue_max
        }
      });
    }
    // Phase 2 #5.x: budget guard. If today's Kimi spend exceeds the daily
    // cap (RALPH_KIMI_DAILY_BUDGET_USD or default $5.00), skip the
    // scheduler tick to prevent runaway spend. Resume automatically when
    // back under cap (e.g., after midnight rollover or operator adds
    // credit). The daemon stays alive so the operator doesn't need to
    // restart it.
    const budget = evaluateBudgetGuard({
      rootDir: options.rootDir,
      env: process.env,
      skip: options.skip_budget_guard === true,
      now
    });

    // Phase 6 #2: stuck-watchdog detection. Runs once per cycle, in parallel
    // semantics with the budget guard — the watchdog never blocks the
    // scheduler; it only enriches the cycle's JSON output so the operator
    // can see stuck stories in the log. Opt-out via RALPH_WATCHDOG_ENABLED=0.
    let watchdog = null;
    const watchdogEnabled = process.env.RALPH_WATCHDOG_ENABLED !== '0';
    if (watchdogEnabled) {
      try {
        watchdog = detectStuckStories({ rootDir: options.rootDir, now, cycleIntervalMs: options.interval_ms });
      } catch (_err) {
        watchdog = { ok: false, reason: 'watchdog_error', stuck: [], mode_expired_blocking: false, checked_at: now.toISOString() };
      }
    }

    let result;
    if (budget.paused) {
      // Synthetic paused-cycle result. No scheduler invocation.
      result = {
        ok: true,
        stage: 'ralph_autonomous_daemon_budget_paused',
        reason: budget.reason,
        execution_connected: false,
        commands_executed: [],
        repository_files_modified: [],
        next_action: 'wait_for_budget_window_or_increase_cap'
      };
    } else {
      result = schedulerTick({
        rootDir: options.rootDir,
        now,
        limit: options.limit,
        ticks_per_story: options.ticks_per_story,
        pre_secret_scan_ok: options.pre_secret_scan_ok === true,
        env: process.env
      });
    }
    const status = daemonStatus(cycle, result, options, supplier, budget, watchdog);
    outputs.push(status);
    console.log(JSON.stringify(status, null, 2));

    if (options.once || (options.max_cycles > 0 && cycle >= options.max_cycles)) break;
    await sleep(options.interval_ms);
  }

  releaseDaemonLock(options.rootDir);

  return {
    ok: outputs.every((item) => item.ok === true),
    stage: 'ralph_autonomous_daemon',
    cycles: outputs.length,
    stopped,
    outputs,
    execution_connected: outputs.some((item) => item.execution_connected),
    commands_executed: outputs.flatMap((item) => item.commands_executed || []).slice(0, 100),
    repository_files_modified: outputs.flatMap((item) => item.repository_files_modified || []).slice(0, 100),
    next_action: stopped ? 'daemon_stopped' : 'daemon_completed_requested_cycles'
  };
}

if (require.main === module) {
  runDaemon().then((result) => {
    if (!result.ok) process.exitCode = 1;
  }).catch((error) => {
    console.error(JSON.stringify({ ok: false, stage: 'ralph_autonomous_daemon', reason: error.message }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = {
  parseBool,
  parseArgs,
  daemonStatus,
  evaluateBudgetGuard,
  runDaemon,
  tryAcquireDaemonLock,
  releaseDaemonLock,
  DAEMON_LOCK_PATH_REL
};
