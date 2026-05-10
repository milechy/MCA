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
