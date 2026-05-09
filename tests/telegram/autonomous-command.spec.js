const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseTelegramCommand } = require('../../src/telegram/command-parser');
const { isAutonomousCommand, handleAutonomousCommand, runUntilBlocked } = require('../../src/telegram/autonomous-command');
const { processTelegramUpdate } = require('../../src/telegram/bot');
const { readStory, updateStory } = require('../../src/ralph/story-queue');
const { LOOP_PHASES } = require('../../src/ralph/autonomous-loop');

function tmpRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-autonomous-command-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'logs', 'audit.jsonl'), '', 'utf8');
  return rootDir;
}

function update(text) {
  return { message: { text, from: { id: 3 }, chat: { id: 10 } } };
}

function config() {
  return { allowed_user_ids: [3], allowed_chat_ids: [10] };
}

test('isAutonomousCommand recognizes Ralph loop command types', () => {
  expect(isAutonomousCommand('ralph_start')).toBe(true);
  expect(isAutonomousCommand('ralph_tick')).toBe(true);
  expect(isAutonomousCommand('ralph_run_until_blocked')).toBe(true);
  expect(isAutonomousCommand('ralph_loop_status')).toBe(true);
  expect(isAutonomousCommand('ping')).toBe(false);
});

test('/ralph-start creates story and performs first autonomous tick', () => {
  const rootDir = tmpRoot();
  const parsed = parseTelegramCommand('/ralph-start Add customer search and tests');
  const response = handleAutonomousCommand(parsed, { rootDir, now: new Date('2026-05-08T14:00:00.000Z'), mode: 'fullauto', target_env: 'local' });

  expect(response).toMatchObject({ ok: true, wired_to_runtime: false, execution_connected: false });
  expect(response.result).toMatchObject({
    ok: true,
    stage: 'ralph_start',
    execution_connected: false,
    repository_files_modified: []
  });
  expect(response.result.story.story_id).toBe('STORY-20260508140000');
  expect(response.result.tick).toMatchObject({
    ok: true,
    stage: 'autonomous_loop_tick',
    to_phase: 'OPENCODE_RUNNING',
    next_action: 'dispatch_opencode_candidate_patch',
    execution_connected: false,
    commands_executed: []
  });
  expect(readStory(rootDir, 'STORY-20260508140000')).toMatchObject({ status: 'running', current_phase: 'OPENCODE_RUNNING' });
  expect(response.text).toContain('Ralph autonomous story started.');
});

test('/ralph-tick advances one story by one bounded step', () => {
  const rootDir = tmpRoot();
  handleAutonomousCommand(parseTelegramCommand('/ralph-start Add test'), { rootDir, now: new Date('2026-05-08T14:00:00.000Z'), mode: 'fullauto' });
  const persisted = updateStory('STORY-20260508140000', { current_phase: LOOP_PHASES.PATCH_PREVIEW, current_approval_id: 'APR-1', current_job_id: 'JOB-1' }, { rootDir, now: new Date('2026-05-08T14:00:30.000Z'), event: 'seed_patch_preview' });
  expect(persisted.ok).toBe(true);

  const response = handleAutonomousCommand(parseTelegramCommand('/ralph-tick STORY-20260508140000'), { rootDir, now: new Date('2026-05-08T14:01:00.000Z') });
  expect(response.result).toMatchObject({ ok: true, from_phase: 'PATCH_PREVIEW', to_phase: 'DIFF_APPROVAL_PENDING', next_action: 'request_diff_approval_then_resume' });
  expect(readStory(rootDir, 'STORY-20260508140000')).toMatchObject({ status: 'waiting_approval', current_phase: 'DIFF_APPROVAL_PENDING' });
});

test('/ralph-run-until-blocked advances bounded ticks until approval boundary', () => {
  const rootDir = tmpRoot();
  handleAutonomousCommand(parseTelegramCommand('/ralph-start Add test'), { rootDir, now: new Date('2026-05-08T14:00:00.000Z'), mode: 'fullauto' });
  const persisted = updateStory('STORY-20260508140000', { current_phase: LOOP_PHASES.PATCH_PREVIEW, current_approval_id: 'APR-1', current_job_id: 'JOB-1' }, { rootDir, now: new Date('2026-05-08T14:00:30.000Z'), event: 'seed_patch_preview' });
  expect(persisted.ok).toBe(true);

  const response = handleAutonomousCommand(parseTelegramCommand('/ralph-run-until-blocked STORY-20260508140000 4'), { rootDir, now: new Date('2026-05-08T14:01:00.000Z') });
  expect(response.result).toMatchObject({ ok: true, stage: 'ralph_run_until_blocked', story_id: 'STORY-20260508140000', tick_count: 1, stopped_at: 'DIFF_APPROVAL_PENDING', next_action: 'request_diff_approval_then_resume' });
  expect(response.result.ticks[0]).toMatchObject({ from_phase: 'PATCH_PREVIEW', to_phase: 'DIFF_APPROVAL_PENDING' });
});

test('runUntilBlocked stops on non-progressing or blocking tick', () => {
  const rootDir = tmpRoot();
  handleAutonomousCommand(parseTelegramCommand('/ralph-start Add test'), { rootDir, now: new Date('2026-05-08T14:00:00.000Z'), mode: 'fullauto' });
  const result = runUntilBlocked('STORY-20260508140000', { rootDir, now: new Date('2026-05-08T14:01:00.000Z'), opencode_dispatcher: () => ({ ok: false, reason: 'preflight_failed', execution_connected: false, commands_executed: [], files_modified: [] }) }, { maxTicks: 3 });
  expect(result).toMatchObject({ ok: false, stage: 'ralph_run_until_blocked', story_id: 'STORY-20260508140000', tick_count: 1, stopped_at: 'OPENCODE_RUNNING', reason: 'preflight_failed', next_action: 'fix_opencode_dispatch_failure' });
});

test('/ralph-loop-status lists stories and reads one story', () => {
  const rootDir = tmpRoot();
  handleAutonomousCommand(parseTelegramCommand('/ralph-start Add test'), { rootDir, now: new Date('2026-05-08T14:00:00.000Z'), mode: 'fullauto' });

  const list = handleAutonomousCommand(parseTelegramCommand('/ralph-loop-status'), { rootDir });
  expect(list.result).toMatchObject({ ok: true, stage: 'ralph_loop_status', execution_connected: false, commands_executed: [] });
  expect(list.result.stories).toHaveLength(1);

  const one = handleAutonomousCommand(parseTelegramCommand('/ralph-loop-status STORY-20260508140000'), { rootDir });
  expect(one.result.story).toMatchObject({ story_id: 'STORY-20260508140000', current_phase: 'OPENCODE_RUNNING' });
});

test('/ralph-pause stops story without execution side effects', () => {
  const rootDir = tmpRoot();
  handleAutonomousCommand(parseTelegramCommand('/ralph-start Add test'), { rootDir, now: new Date('2026-05-08T14:00:00.000Z'), mode: 'fullauto' });
  const response = handleAutonomousCommand(parseTelegramCommand('/ralph-pause STORY-20260508140000'), { rootDir, now: new Date('2026-05-08T14:01:00.000Z') });
  expect(response.result).toMatchObject({ ok: true, to_phase: 'STOPPED', execution_connected: false, commands_executed: [] });
  expect(readStory(rootDir, 'STORY-20260508140000')).toMatchObject({ status: 'stopped', current_phase: 'STOPPED' });
});

test('processTelegramUpdate routes autonomous commands through bot', async () => {
  const rootDir = tmpRoot();
  const result = await processTelegramUpdate(update('/ralph-start Add Telegram autonomous story'), {
    rootDir,
    config: config(),
    roles: { reviewer_user_ids: [3] },
    now: new Date('2026-05-08T14:00:00.000Z'),
    mode: 'fullauto'
  });
  expect(result.ok).toBe(true);
  expect(result.parsed.type).toBe('ralph_start');
  expect(result.response.result.story.story_id).toBe('STORY-20260508140000');
  expect(result.response_text).toContain('Ralph autonomous story started.');
});
