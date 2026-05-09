const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStory } = require('../../src/ralph/story-queue');
const {
  generateDashboard,
  dashboardToMarkdown,
  readApprovals,
  readRecentAuditEvents,
  redactText
} = require('../../src/ralph/dashboard');
const { parseArgs, renderDashboard } = require('../../scripts/ralph/dashboard');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-dashboard-'));
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath, value) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function fakeGitHubToken() {
  return ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz'].join('');
}

test('generateDashboard groups stories, approvals, jobs, gates and next actions', () => {
  const rootDir = tmpRoot();
  createStory({ story_id: 'STORY-ACTIVE', requirement: 'Run active story', status: 'running', current_phase: 'GATES', current_job_id: 'JOB-1' }, { rootDir });
  createStory({ story_id: 'STORY-WAIT', requirement: 'Waiting story', status: 'waiting_approval', current_phase: 'DIFF_APPROVAL_PENDING', current_approval_id: 'APR-1' }, { rootDir });
  createStory({ story_id: 'STORY-FAIL', requirement: 'Failed story', status: 'failed', current_phase: 'ESCALATED', blocked_reason: 'retry_exhausted' }, { rootDir });
  createStory({ story_id: 'STORY-DONE', requirement: 'Done story', status: 'completed', current_phase: 'DONE' }, { rootDir });

  writeJson(path.join(rootDir, '.ralph', 'approval-pending', 'APR-1.json'), {
    approval_id: 'APR-1',
    approval_type: 'diff',
    story_id: 'STORY-WAIT',
    status: 'pending',
    requested_action: 'diff',
    plan_hash: 'sha256:plan',
    pre_exec_diff_hash: 'sha256:pre',
    expires_at: '2026-05-09T05:00:00.000Z'
  });
  appendJsonl(path.join(rootDir, '.ralph', 'logs', 'audit.jsonl'), { timestamp: '2026-05-09T04:00:00.000Z', event: 'approval_requested', story_id: 'STORY-WAIT', approval_id: 'APR-1' });
  appendJsonl(path.join(rootDir, '.ralph', 'logs', 'execution.jsonl'), { timestamp: '2026-05-09T04:01:00.000Z', event: 'opencode_candidate_patch_created', story_id: 'STORY-ACTIVE' });
  appendJsonl(path.join(rootDir, '.ralph', 'logs', 'execution.jsonl'), { timestamp: '2026-05-09T04:02:00.000Z', summary: { stage: 'ralph_gate_runner', reason: 'gate_failed', story_id: 'STORY-ACTIVE' } });

  const dashboard = generateDashboard({ rootDir, now: new Date('2026-05-09T04:03:00.000Z') });

  expect(dashboard).toMatchObject({
    ok: true,
    stage: 'ralph_dashboard',
    execution_connected: false,
    commands_executed: [],
    repository_files_modified: [],
    counts: {
      active: 1,
      waiting_approval: 1,
      failed: 1,
      completed: 1,
      pending_approvals: 1
    },
    next_action: 'resolve_pending_approvals'
  });
  expect(dashboard.stories.active[0]).toMatchObject({ story_id: 'STORY-ACTIVE', next_action: 'advance_gates' });
  expect(dashboard.stories.waiting_approval[0]).toMatchObject({ story_id: 'STORY-WAIT', next_action: 'approve_or_modify_story_before_resume' });
  expect(dashboard.approvals[0]).toMatchObject({ approval_id: 'APR-1', next_action: 'approve_deny_or_modify' });
  expect(dashboard.jobs.map((job) => job.event)).toContain('opencode_candidate_patch_created');
  expect(dashboard.gates.map((gate) => gate.stage)).toContain('ralph_gate_runner');
});

test('dashboard output redacts secrets and bounds recent audit events', () => {
  const rootDir = tmpRoot();
  const tokenFixture = fakeGitHubToken();
  const emailFixture = ['dev', 'example.com'].join('@');
  createStory({ story_id: 'STORY-SECRET', requirement: `password: hunter2 ${emailFixture} ${tokenFixture}`, status: 'running', current_phase: 'PLAN' }, { rootDir });
  writeJson(path.join(rootDir, '.ralph', 'approval-pending', 'APR-SECRET.json'), {
    approval_id: `APR-${tokenFixture}`,
    status: 'pending',
    approved_by: emailFixture,
    plan_hash: tokenFixture
  });
  for (let index = 0; index < 40; index += 1) {
    appendJsonl(path.join(rootDir, '.ralph', 'logs', 'audit.jsonl'), { timestamp: `2026-05-09T04:${String(index).padStart(2, '0')}:00.000Z`, event: `event-${index}`, reason: `secret=${tokenFixture}` });
  }

  const dashboard = generateDashboard({ rootDir, recent_limit: 10 });
  const serialized = JSON.stringify(dashboard);
  expect(serialized).not.toContain(tokenFixture);
  expect(serialized).not.toContain(emailFixture);
  expect(serialized).not.toContain('hunter2');
  expect(dashboard.recent_audit_events).toHaveLength(10);
});

test('dashboardToMarkdown renders key sections', () => {
  const rootDir = tmpRoot();
  createStory({ story_id: 'STORY-MD', requirement: 'Markdown story', status: 'running', current_phase: 'PLAN' }, { rootDir });
  const markdown = dashboardToMarkdown(generateDashboard({ rootDir, now: new Date('2026-05-09T04:04:00.000Z') }));
  expect(markdown).toContain('# Ralph Dashboard');
  expect(markdown).toContain('## Counts');
  expect(markdown).toContain('## Active stories');
  expect(markdown).toContain('STORY-MD');
  expect(markdown).toContain('## Recent audit events');
});

test('readApprovals and readRecentAuditEvents tolerate missing directories', () => {
  const rootDir = tmpRoot();
  expect(readApprovals(rootDir)).toEqual([]);
  expect(readRecentAuditEvents(rootDir)).toEqual([]);
});

test('dashboard CLI parser and renderer support json and markdown', () => {
  const parsed = parseArgs(['--root', '/tmp/mca', '--markdown', '--story-limit', '7', '--recent-limit', '3']);
  expect(parsed).toMatchObject({ rootDir: '/tmp/mca', format: 'markdown', story_limit: 7, recent_limit: 3 });
  const dashboard = { ok: true, generated_at: 'now', counts: { active: 0, waiting_approval: 0, failed: 0, completed: 0, stopped: 0, pending_approvals: 0 }, stories: { active: [], waiting_approval: [], failed: [], completed: [] }, recent_audit_events: [] };
  expect(renderDashboard(dashboard, 'json')).toContain('"ok": true');
  expect(renderDashboard(dashboard, 'markdown')).toContain('# Ralph Dashboard');
});

test('redactText removes common secret-shaped values', () => {
  const tokenFixture = fakeGitHubToken();
  const emailFixture = ['root', 'example.com'].join('@');
  const text = redactText(`token=abc password: hunter2 ${emailFixture} ${tokenFixture}`);
  expect(text).not.toContain('hunter2');
  expect(text).not.toContain(emailFixture);
  expect(text).not.toContain(tokenFixture);
});
