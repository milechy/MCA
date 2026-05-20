const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_REVIEWER_MODEL,
  DEFAULT_MAX_RETRIES,
  MAX_DIFF_CHARS,
  REVIEW_PROMPT_TEMPLATE,
  VALID_VERDICTS,
  VALID_SEVERITIES,
  stripCodeFence,
  extractReviewerJson,
  validateReviewerOutput,
  fetchPrMetadata,
  fetchPrDiff,
  reviewPullRequest
} = require('../../src/ralph/pr-reviewer');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-reviewer-'));
}

// -- Schema constants -------------------------------------------------------

test('DEFAULT_REVIEWER_MODEL targets a Claude family slug', () => {
  expect(DEFAULT_REVIEWER_MODEL).toContain('claude');
  expect(DEFAULT_REVIEWER_MODEL).toContain('openrouter/');
});

test('VALID_VERDICTS covers approve / request_changes / comment exactly', () => {
  expect([...VALID_VERDICTS].sort()).toEqual(['approve', 'comment', 'request_changes']);
});

test('VALID_SEVERITIES covers blocker / warn / nit exactly', () => {
  expect([...VALID_SEVERITIES].sort()).toEqual(['blocker', 'nit', 'warn']);
});

test('REVIEW_PROMPT_TEMPLATE contains the three required placeholders', () => {
  expect(REVIEW_PROMPT_TEMPLATE).toContain('{TITLE}');
  expect(REVIEW_PROMPT_TEMPLATE).toContain('{BODY}');
  expect(REVIEW_PROMPT_TEMPLATE).toContain('{DIFF}');
});

// -- stripCodeFence ---------------------------------------------------------

test('stripCodeFence strips ```json fences and is a no-op on plain text', () => {
  expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
  expect(stripCodeFence('plain text')).toBe('plain text');
  expect(stripCodeFence('')).toBe('');
  expect(stripCodeFence(null)).toBe('');
});

// -- extractReviewerJson ----------------------------------------------------

test('extractReviewerJson handles pure JSON (unit-test fake spawn shape)', () => {
  const stdout = JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine' });
  expect(extractReviewerJson(stdout)).toMatchObject({ verdict: 'approve', summary: 'fine' });
});

test('extractReviewerJson handles opencode NDJSON streaming envelope', () => {
  const lines = [
    JSON.stringify({ type: 'step_start', part: { id: 'p1' } }),
    JSON.stringify({ type: 'text', part: { id: 'p2', type: 'text', text: '```json\n{"verdict":"approve","issues":[],"summary":"LGTM"}\n```' } }),
    JSON.stringify({ type: 'step_finish', part: { id: 'p3' } })
  ];
  const result = extractReviewerJson(lines.join('\n'));
  expect(result).toMatchObject({ verdict: 'approve', summary: 'LGTM' });
});

test('extractReviewerJson concatenates text from multiple text events', () => {
  const lines = [
    JSON.stringify({ type: 'text', part: { type: 'text', text: '```json\n{"verdict":"comment",' } }),
    JSON.stringify({ type: 'text', part: { type: 'text', text: '"issues":[],"summary":"meh"}\n```' } })
  ];
  expect(extractReviewerJson(lines.join('\n'))).toMatchObject({ verdict: 'comment', summary: 'meh' });
});

test('extractReviewerJson returns null on empty / unparsable / no-text input', () => {
  expect(extractReviewerJson('')).toBe(null);
  expect(extractReviewerJson(null)).toBe(null);
  expect(extractReviewerJson('not json at all')).toBe(null);
  expect(extractReviewerJson(JSON.stringify({ type: 'text', part: { type: 'text', text: '```json\nbroken\n```' } }))).toBe(null);
});

// -- validateReviewerOutput -------------------------------------------------

test('validateReviewerOutput accepts minimal approve with empty issues', () => {
  expect(validateReviewerOutput({ verdict: 'approve', issues: [], summary: 'fine' })).toBe(true);
});

test('validateReviewerOutput accepts request_changes with one blocker', () => {
  expect(validateReviewerOutput({
    verdict: 'request_changes',
    issues: [{ file: 'src/a.js', line: 12, severity: 'blocker', message: 'secret leak' }],
    summary: 'blocker present'
  })).toBe(true);
});

test('validateReviewerOutput rejects approve with a blocker (consistency check)', () => {
  expect(validateReviewerOutput({
    verdict: 'approve',
    issues: [{ file: 'src/a.js', severity: 'blocker', message: 'oops' }],
    summary: 'inconsistent'
  })).toBe(false);
});

test('validateReviewerOutput rejects unknown verdict', () => {
  expect(validateReviewerOutput({ verdict: 'lgtm', issues: [], summary: 'x' })).toBe(false);
});

test('validateReviewerOutput rejects unknown severity', () => {
  expect(validateReviewerOutput({
    verdict: 'comment',
    issues: [{ file: 'src/a.js', severity: 'panic', message: 'x' }],
    summary: 's'
  })).toBe(false);
});

test('validateReviewerOutput rejects missing required fields', () => {
  expect(validateReviewerOutput({ issues: [], summary: 's' })).toBe(false);
  expect(validateReviewerOutput({ verdict: 'approve', summary: 's' })).toBe(false);
  expect(validateReviewerOutput({ verdict: 'approve', issues: [] })).toBe(false);
  expect(validateReviewerOutput(null)).toBe(false);
  expect(validateReviewerOutput('not even an object')).toBe(false);
});

test('validateReviewerOutput rejects issue with non-numeric line', () => {
  expect(validateReviewerOutput({
    verdict: 'comment',
    issues: [{ file: 'a', line: 'not a number', severity: 'nit', message: 'x' }],
    summary: 's'
  })).toBe(false);
});

test('validateReviewerOutput accepts issue without line (whole-file scope)', () => {
  expect(validateReviewerOutput({
    verdict: 'comment',
    issues: [{ file: 'a', severity: 'nit', message: 'x' }],
    summary: 's'
  })).toBe(true);
});

// -- fetchPrMetadata --------------------------------------------------------

test('fetchPrMetadata parses gh json output on success', () => {
  const spawn = (cmd, args) => {
    expect(cmd).toBe('gh');
    expect(args[0]).toBe('pr');
    expect(args[1]).toBe('view');
    expect(args[2]).toBe('42');
    return { status: 0, stdout: JSON.stringify({ title: 'T', body: 'B', baseRefName: 'main', headRefName: 'f', additions: 1, deletions: 0 }) };
  };
  const r = fetchPrMetadata({ pr_number: 42, spawn });
  expect(r).toMatchObject({ ok: true, metadata: { title: 'T', baseRefName: 'main' } });
});

test('fetchPrMetadata returns reason on non-zero exit', () => {
  const spawn = () => ({ status: 1, stderr: 'gh: not authenticated' });
  expect(fetchPrMetadata({ pr_number: 42, spawn })).toMatchObject({ ok: false, reason: 'gh_pr_view_failed' });
});

test('fetchPrMetadata returns reason on malformed JSON', () => {
  const spawn = () => ({ status: 0, stdout: 'not json' });
  expect(fetchPrMetadata({ pr_number: 42, spawn })).toMatchObject({ ok: false, reason: 'gh_pr_view_malformed_json' });
});

// -- fetchPrDiff ------------------------------------------------------------

test('fetchPrDiff returns full diff when under the cap', () => {
  const diff = 'diff --git a/a b/a\n+hello\n';
  const spawn = (cmd, args) => {
    expect(args[1]).toBe('diff');
    return { status: 0, stdout: diff };
  };
  const r = fetchPrDiff({ pr_number: 7, spawn });
  expect(r).toMatchObject({ ok: true, diff, truncated: false });
});

test('fetchPrDiff truncates diff over MAX_DIFF_CHARS and marks truncated=true', () => {
  const huge = 'x'.repeat(MAX_DIFF_CHARS + 10);
  const spawn = () => ({ status: 0, stdout: huge });
  const r = fetchPrDiff({ pr_number: 7, spawn });
  expect(r.ok).toBe(true);
  expect(r.truncated).toBe(true);
  expect(r.diff.length).toBeLessThan(MAX_DIFF_CHARS + 100);
  expect(r.diff).toContain('[diff truncated for reviewer context]');
});

test('fetchPrDiff propagates failure reason', () => {
  const spawn = () => ({ status: 1, stderr: 'no such PR' });
  expect(fetchPrDiff({ pr_number: 7, spawn })).toMatchObject({ ok: false, reason: 'gh_pr_diff_failed' });
});

// -- reviewPullRequest ------------------------------------------------------

function makeReviewerSpawn(events = {}) {
  // events: { pr_view, pr_diff, opencode } each = { status, stdout, stderr }
  const defaults = {
    pr_view: { status: 0, stdout: JSON.stringify({ title: 'PR Title', body: 'PR Body', baseRefName: 'main', headRefName: 'feat/x', additions: 5, deletions: 1 }) },
    pr_diff: { status: 0, stdout: 'diff --git a/src/x.js b/src/x.js\n+console.log("hi")\n' },
    opencode: { status: 0, stdout: JSON.stringify({ verdict: 'approve', issues: [], summary: 'LGTM' }) }
  };
  const cfg = { ...defaults, ...events };
  return function spawn(cmd, args) {
    if (cmd === 'gh' && args[1] === 'view') return cfg.pr_view;
    if (cmd === 'gh' && args[1] === 'diff') return cfg.pr_diff;
    if (cmd === 'opencode') return cfg.opencode;
    return { status: 0, stdout: '' };
  };
}

test('reviewPullRequest rejects missing pr_number', () => {
  expect(reviewPullRequest({ env: { OPENROUTER_API_KEY: 'k' } })).toMatchObject({ ok: false, reason: 'pr_number_required' });
});

test('reviewPullRequest rejects missing OPENROUTER_API_KEY', () => {
  expect(reviewPullRequest({ pr_number: 1, env: {} })).toMatchObject({ ok: false, reason: 'openrouter_api_key_missing' });
});

test('reviewPullRequest returns approve verdict on happy path', () => {
  const rootDir = tmpRoot();
  const spawn = makeReviewerSpawn();
  const result = reviewPullRequest({
    pr_number: 42,
    rootDir,
    env: { OPENROUTER_API_KEY: 'k', PATH: '/usr/bin', HOME: '/tmp' },
    spawn
  });
  expect(result).toMatchObject({
    ok: true,
    pr_number: 42,
    verdict: 'approve',
    summary: 'LGTM',
    pr_title: 'PR Title'
  });
  expect(Array.isArray(result.issues)).toBe(true);
  expect(result.issues).toEqual([]);
  expect(result.cost_usd).toBeGreaterThanOrEqual(0);
});

test('reviewPullRequest returns request_changes with issues when reviewer reports blocker', () => {
  const rootDir = tmpRoot();
  const spawn = makeReviewerSpawn({
    opencode: { status: 0, stdout: JSON.stringify({
      verdict: 'request_changes',
      issues: [{ file: 'src/x.js', line: 7, severity: 'blocker', message: 'introduces secret in plaintext' }],
      summary: 'security regression'
    }) }
  });
  const result = reviewPullRequest({
    pr_number: 1,
    rootDir,
    env: { OPENROUTER_API_KEY: 'k', PATH: '/usr/bin', HOME: '/tmp' },
    spawn
  });
  expect(result.ok).toBe(true);
  expect(result.verdict).toBe('request_changes');
  expect(result.issues).toHaveLength(1);
  expect(result.issues[0]).toMatchObject({ severity: 'blocker', file: 'src/x.js' });
});

test('reviewPullRequest retries when reviewer returns malformed output, then succeeds', () => {
  const rootDir = tmpRoot();
  let opencodeCallCount = 0;
  const spawn = (cmd, args) => {
    if (cmd === 'gh' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ title: 'T', body: '', baseRefName: 'main', headRefName: 'f', additions: 1, deletions: 0 }) };
    if (cmd === 'gh' && args[1] === 'diff') return { status: 0, stdout: 'diff --git a/a b/a\n+x\n' };
    if (cmd === 'opencode') {
      opencodeCallCount += 1;
      if (opencodeCallCount === 1) return { status: 0, stdout: 'definitely not json' };
      return { status: 0, stdout: JSON.stringify({ verdict: 'approve', issues: [], summary: 'recovered' }) };
    }
    return { status: 0, stdout: '' };
  };
  const result = reviewPullRequest({
    pr_number: 9,
    rootDir,
    env: { OPENROUTER_API_KEY: 'k', PATH: '/usr/bin', HOME: '/tmp' },
    spawn,
    maxRetries: 1
  });
  expect(result.ok).toBe(true);
  expect(result.summary).toBe('recovered');
  expect(opencodeCallCount).toBe(2);
});

test('reviewPullRequest returns reviewer_invalid_response after exhausting retries', () => {
  const rootDir = tmpRoot();
  const spawn = makeReviewerSpawn({
    opencode: { status: 0, stdout: 'never json' }
  });
  const result = reviewPullRequest({
    pr_number: 9,
    rootDir,
    env: { OPENROUTER_API_KEY: 'k', PATH: '/usr/bin', HOME: '/tmp' },
    spawn,
    maxRetries: 0
  });
  expect(result).toMatchObject({ ok: false, reason: 'reviewer_invalid_response', pr_number: 9 });
});

test('reviewPullRequest propagates gh failures', () => {
  const rootDir = tmpRoot();
  const spawn = makeReviewerSpawn({ pr_view: { status: 1, stderr: 'gh down' } });
  const result = reviewPullRequest({
    pr_number: 9,
    rootDir,
    env: { OPENROUTER_API_KEY: 'k', PATH: '/usr/bin', HOME: '/tmp' },
    spawn
  });
  expect(result).toMatchObject({ ok: false, reason: 'gh_pr_view_failed' });
});

test('reviewPullRequest propagates opencode dispatch failures', () => {
  const rootDir = tmpRoot();
  const spawn = makeReviewerSpawn({ opencode: { status: 1, stderr: 'opencode crashed' } });
  const result = reviewPullRequest({
    pr_number: 9,
    rootDir,
    env: { OPENROUTER_API_KEY: 'k', PATH: '/usr/bin', HOME: '/tmp' },
    spawn
  });
  expect(result).toMatchObject({ ok: false, reason: 'reviewer_dispatch_failed' });
});

test('reviewPullRequest rejects a verdict-vs-issues mismatch (approve with blocker)', () => {
  const rootDir = tmpRoot();
  // Reviewer returns an internally-inconsistent verdict — schema validator must catch it.
  const spawn = makeReviewerSpawn({
    opencode: { status: 0, stdout: JSON.stringify({
      verdict: 'approve',
      issues: [{ file: 'src/x.js', severity: 'blocker', message: 'leak' }],
      summary: 'inconsistent'
    }) }
  });
  const result = reviewPullRequest({
    pr_number: 9,
    rootDir,
    env: { OPENROUTER_API_KEY: 'k', PATH: '/usr/bin', HOME: '/tmp' },
    spawn,
    maxRetries: 0
  });
  expect(result).toMatchObject({ ok: false, reason: 'reviewer_invalid_response' });
});
