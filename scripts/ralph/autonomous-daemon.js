#!/usr/bin/env node
const { schedulerTick } = require('../../src/ralph/autonomous-scheduler');

function parseBool(value) {
  return value === true || value === 'true';
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
  return {
    once: has('--once'),
    interval_ms: Number.isFinite(intervalMs) && intervalMs >= 1000 ? Math.min(intervalMs, 3600000) : 60000,
    max_cycles: Number.isFinite(maxCycles) && maxCycles >= 0 ? Math.min(maxCycles, 1000000) : 0,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 25) : 1,
    ticks_per_story: Number.isFinite(ticksPerStory) && ticksPerStory > 0 ? Math.min(ticksPerStory, 12) : 1,
    rootDir: value('--root', process.cwd()),
    pre_secret_scan_ok: preSecretScanOk
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function daemonStatus(cycle, result, options) {
  return {
    ok: result.ok === true,
    stage: 'ralph_autonomous_daemon_cycle',
    cycle,
    interval_ms: options.interval_ms,
    limit: options.limit,
    ticks_per_story: options.ticks_per_story,
    pre_secret_scan_ok: options.pre_secret_scan_ok === true,
    scheduler: result,
    execution_connected: result.execution_connected === true,
    commands_executed: result.commands_executed || [],
    repository_files_modified: result.repository_files_modified || [],
    next_action: result.next_action
  };
}

async function runDaemon(options = parseArgs()) {
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once?.('SIGINT', stop);
  process.once?.('SIGTERM', stop);

  const outputs = [];
  let cycle = 0;
  while (!stopped) {
    cycle += 1;
    const result = schedulerTick({
      rootDir: options.rootDir,
      now: new Date(),
      limit: options.limit,
      ticks_per_story: options.ticks_per_story,
      pre_secret_scan_ok: options.pre_secret_scan_ok === true,
      env: process.env
    });
    const status = daemonStatus(cycle, result, options);
    outputs.push(status);
    console.log(JSON.stringify(status, null, 2));

    if (options.once || (options.max_cycles > 0 && cycle >= options.max_cycles)) break;
    await sleep(options.interval_ms);
  }

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
  runDaemon
};
