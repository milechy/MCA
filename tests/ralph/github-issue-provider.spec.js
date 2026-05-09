const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStory, readStory } = require('../../src/ralph/story-queue');
const {
  filterEligibleIssues,
  fetchOpenIssues,
  importGitHubIssuesFromProvider,
  redactText
} = require('../../src/ralph/github-issue-provider');
const { parseArgs, boundedOutput } = require('../../scripts/ralph/import-github-issues');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-github-issue-provider-'));
}

function fakeGitHubToken() {
  return ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz'].join('');
}

test('fetchOpenIssues uses injected provider fetch and returns redacted bounded issue summaries', async () => {
  const calls = [];
  const tokenFixture = fakeGitHubToken();
  const emailFixture = ['dev', 'example.com'].join('@');
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      async json() {
        return [
          {
            number: 42,
            title: `Use token ${tokenFixture} in docs`,
            body: `secret: should-not-print\nContact ${emailFixture}`,
            html_url: 'https://github.com/milechy/MCA/issues/42',
            labels: [{ name: 'ralph-ready' }],
            state: 'open'
          },
          {
            number: 99,
            title: 'Open PR should not import as issue',
            pull_request: { url: 'https://api.github.com/repos/milechy/MCA/pulls/99' },
            labels: [{ name: 'ralph-ready' }]
          }
        ];
      }
    };
  };

  const result = await fetchOpenIssues({ repo: 'milechy/MCA', token: 'test-token', fetchImpl, maxIssues: 10 });

  expect(result).toMatchObject({
    ok: true,
    stage: 'github_issue_provider_fetch',
    repo: 'milechy/MCA',
    fetched: 1,
    execution_connected: false,
    github_write_connected: false,
    commands_executed: [],
    repository_files_modified: []
  });
  expect(calls[0].url).toContain('/repos/milechy/MCA/issues?state=open');
  expect(calls[0].options.method).toBe('GET');
  expect(calls[0].options.headers.Authorization).toBe('Bearer test-token');
  expect(JSON.stringify(result)).not.toContain(tokenFixture);
  expect(JSON.stringify(result)).not.toContain(emailFixture);
  expect(JSON.stringify(result)).not.toContain('should-not-print');
});

test('filterEligibleIssues applies ready label filter and drops duplicate fetched issues', () => {
  const result = filterEligibleIssues([
    { number: 1, title: 'A', labels: [{ name: 'ralph-ready' }] },
    { number: 2, title: 'B', labels: [{ name: 'needs-triage' }] },
    { number: 1, title: 'A duplicate', labels: [{ name: 'ralph-ready' }] }
  ], { readyLabels: ['ralph-ready', 'autonomous'] });

  expect(result.eligible.map((issue) => issue.issue_number)).toEqual([1]);
  expect(result.skipped).toEqual(expect.arrayContaining([
    expect.objectContaining({ issue_number: 2, reason: 'label_filter_not_matched' }),
    expect.objectContaining({ issue_number: 1, reason: 'duplicate_issue_in_fetch' })
  ]));
});

test('importGitHubIssuesFromProvider converts eligible issues to STORY-GH records and skips existing stories', async () => {
  const rootDir = tmpRoot();
  const existing = createStory({
    story_id: 'STORY-GH-10',
    requirement: 'Existing imported issue',
    github_issue: { issue_number: 10, title: 'Existing', labels: ['ralph-ready'] }
  }, { rootDir, now: new Date('2026-05-09T00:00:00.000Z') });
  expect(existing.ok).toBe(true);

  const provider = async () => ({
    ok: true,
    issues: [
      { number: 10, title: 'Existing', body: 'do not duplicate', html_url: 'https://github.com/milechy/MCA/issues/10', labels: ['ralph-ready'] },
      { number: 11, title: 'New autonomous task', body: 'implement safely', html_url: 'https://github.com/milechy/MCA/issues/11', labels: ['autonomous', 'p2'] }
    ]
  });

  const result = await importGitHubIssuesFromProvider({
    provider,
    repo: 'milechy/MCA',
    rootDir,
    now: new Date('2026-05-09T01:00:00.000Z')
  });

  expect(result.imported.map((story) => story.story_id)).toEqual(['STORY-GH-11']);
  expect(result.skipped).toEqual(expect.arrayContaining([
    expect.objectContaining({ story_id: 'STORY-GH-10', reason: 'story_already_exists', issue_number: 10 })
  ]));
  expect(readStory(rootDir, 'STORY-GH-11')).toMatchObject({
    story_id: 'STORY-GH-11',
    title: 'New autonomous task',
    labels: ['autonomous', 'p2'],
    github_issue: {
      issue_number: 11,
      title: 'New autonomous task',
      url: 'https://github.com/milechy/MCA/issues/11',
      labels: ['autonomous', 'p2']
    }
  });
});

test('importGitHubIssuesFromProvider sorts imported stories by priority labels', async () => {
  const rootDir = tmpRoot();
  const provider = async () => ({
    ok: true,
    issues: [
      { number: 20, title: 'Medium later', labels: ['ralph-ready', 'p2'] },
      { number: 21, title: 'Critical first', labels: ['ralph-ready', 'p0'] },
      { number: 22, title: 'High second', labels: ['ralph-ready', 'p1'] }
    ]
  });

  const result = await importGitHubIssuesFromProvider({ provider, repo: 'milechy/MCA', rootDir });

  expect(result.imported.map((story) => story.story_id)).toEqual(['STORY-GH-21', 'STORY-GH-22', 'STORY-GH-20']);
});

test('import script parsing and bounded output are safe by default', () => {
  const parsed = parseArgs(['--repo', 'milechy/MCA', '--labels', 'ralph-ready,autonomous', '--max-issues', '7', '--root', '/tmp/mca'], {});
  expect(parsed).toMatchObject({
    repo: 'milechy/MCA',
    readyLabels: ['ralph-ready', 'autonomous'],
    maxIssues: 7,
    rootDir: '/tmp/mca'
  });

  const output = boundedOutput({
    ok: true,
    stage: 'github_issue_provider_import',
    repo: 'milechy/MCA',
    ready_labels: ['ralph-ready'],
    fetched_count: 1,
    eligible_count: 1,
    imported: [{ story_id: 'STORY-GH-1' }],
    skipped: [],
    issue_summaries: [{ body: 'raw body should be omitted' }],
    next_action: 'run_autonomous_scheduler_tick'
  });
  expect(output.issue_summaries).toBeUndefined();
  expect(JSON.stringify(output)).not.toContain('raw body');
  expect(output.github_write_connected).toBe(false);
});

test('redactText removes common secret-shaped values from output strings', () => {
  const tokenFixture = fakeGitHubToken();
  const emailFixture = ['root', 'example.com'].join('@');
  const text = redactText(`token=abc123456 password: hunter2 email ${emailFixture} ${tokenFixture}`);
  expect(text).not.toContain('hunter2');
  expect(text).not.toContain(emailFixture);
  expect(text).not.toContain(tokenFixture);
});
