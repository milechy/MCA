const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  inferLanguage,
  inferTaskKind,
  contextBucket,
  extractContext,
  deriveSucceeded,
  deriveActualDifficulty,
  summarizeCost,
  executionId,
  buildOutcomeRecord,
  selectSink,
  recordTaskOutcome
} = require('../../src/ralph/task-outcome-recorder');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-recorder-'));
}

function story(overrides = {}) {
  return {
    story_id: 'STORY-X',
    requirement: 'FILE 1 (MODIFY EXISTING): change src/foo.js to add a helper function. FILE 2 (CREATE): tests/foo.spec.js with new cases.',
    requested_paths: ['src/ralph/foo.js', 'tests/ralph/foo.spec.js'],
    difficulty: 'medium',
    status: 'completed',
    current_phase: 'DONE',
    attempts: 0,
    executor_model: 'openrouter/anthropic/claude-haiku-4.5',
    planner_model: 'openrouter/deepseek/deepseek-chat',
    routing_source: 'difficulty_tier',
    created_at: '2026-05-29T00:00:00.000Z',
    ...overrides
  };
}

test('inferLanguage picks the dominant extension', () => {
  expect(inferLanguage(['a.js', 'b.js', 'c.md'])).toBe('js');
  expect(inferLanguage(['a.ts', 'b.tsx'])).toBe('ts');
  expect(inferLanguage([])).toBe('unknown');
});

test('inferTaskKind classifies create/modify/refactor/test_only/docs', () => {
  expect(inferTaskKind('FILE 1 (CREATE): add a new helper', ['src/x.js'])).toBe('create');
  expect(inferTaskKind('FILE 1 (MODIFY EXISTING): change x', ['src/x.js'])).toBe('modify');
  expect(inferTaskKind('please refactor the module', ['src/x.js'])).toBe('refactor');
  expect(inferTaskKind('anything', ['tests/x.spec.js'])).toBe('test_only');
  expect(inferTaskKind('anything', ['docs/x.md'])).toBe('docs');
});

test('contextBucket is coarse and stable', () => {
  expect(contextBucket({ difficulty: 'medium', task_kind: 'modify', language: 'js', requested_paths: 2 }))
    .toBe('medium|modify|js|2-3f');
  expect(contextBucket({ difficulty: 'easy', task_kind: 'create', language: 'ts', requested_paths: 1 }))
    .toBe('easy|create|ts|1f');
  expect(contextBucket({ difficulty: 'hard', task_kind: 'refactor', language: 'py', requested_paths: 9 }))
    .toBe('hard|refactor|py|4+f');
});

test('extractContext produces all decision-input features', () => {
  const ctx = extractContext(story());
  expect(ctx.story_id).toBe('STORY-X');
  expect(ctx.difficulty).toBe('medium');
  expect(ctx.task_kind).toBe('mixed'); // has both CREATE and MODIFY EXISTING
  expect(ctx.requested_paths).toBe(2);
  expect(ctx.language).toBe('js');
  expect(ctx.spec_chars).toBeGreaterThan(0);
  expect(ctx.context_bucket).toBe('medium|mixed|js|2-3f');
});

test('deriveSucceeded maps phase/status to true/false/null', () => {
  expect(deriveSucceeded({ status: 'completed', current_phase: 'DONE' })).toBe(true);
  expect(deriveSucceeded({ status: 'failed', current_phase: 'ESCALATED' })).toBe(false);
  expect(deriveSucceeded({ status: 'running', current_phase: 'GATES' })).toBe(null);
});

test('deriveActualDifficulty escalates with retries/cost', () => {
  expect(deriveActualDifficulty({ fix_loop_attempts: 0, executor_cost_usd: 0.001, succeeded: true })).toBe('trivial');
  expect(deriveActualDifficulty({ fix_loop_attempts: 0, executor_cost_usd: 0.03, succeeded: true })).toBe('easy');
  expect(deriveActualDifficulty({ fix_loop_attempts: 1, executor_cost_usd: 0.05, succeeded: true })).toBe('medium');
  expect(deriveActualDifficulty({ fix_loop_attempts: 3, executor_cost_usd: 0.05, succeeded: true })).toBe('hard');
  expect(deriveActualDifficulty({ succeeded: false })).toBe('hard');
});

test('summarizeCost splits planner vs executor by model', () => {
  const entries = [
    { model: 'openrouter/deepseek/deepseek-chat', cost_usd: 0.0009, story_id: null },
    { model: 'openrouter/anthropic/claude-haiku-4.5', cost_usd: 0.074, story_id: 'STORY-X' }
  ];
  const r = summarizeCost(entries, story());
  expect(r.planner_cost_usd).toBeCloseTo(0.0009, 6);
  expect(r.executor_cost_usd).toBeCloseTo(0.074, 6);
});

test('executionId is deterministic (same inputs → same id) for idempotency', () => {
  const a = executionId({ story_id: 'S', attempt_number: 1, model: 'm', role: 'executor' });
  const b = executionId({ story_id: 'S', attempt_number: 1, model: 'm', role: 'executor' });
  const c = executionId({ story_id: 'S', attempt_number: 2, model: 'm', role: 'executor' });
  expect(a).toBe(b);
  expect(a).not.toBe(c);
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('buildOutcomeRecord ties context + executions + summary together', () => {
  const entries = [
    { model: 'openrouter/deepseek/deepseek-chat', cost_usd: 0.0009, story_id: null },
    { model: 'openrouter/anthropic/claude-haiku-4.5', cost_usd: 0.074, story_id: 'STORY-X' }
  ];
  const rec = buildOutcomeRecord({ story: story(), ledgerEntries: entries });
  expect(rec.task.context_bucket).toBe('medium|mixed|js|2-3f');
  // executor cost 0.074 (< 0.10), 0 retries, succeeded ⇒ 'easy' by the
  // back-computation heuristic. NOTE: planner predicted 'medium' → this is
  // exactly the predicted-vs-actual gap that 11-D will calibrate.
  expect(rec.task.actual_difficulty).toBe('easy');
  expect(rec.executions.length).toBe(2);
  const exec = rec.executions.find((e) => e.role === 'executor');
  expect(exec.succeeded).toBe(true);
  expect(exec.model).toBe('openrouter/anthropic/claude-haiku-4.5');
  const planner = rec.executions.find((e) => e.role === 'planner');
  expect(planner.succeeded).toBe(null);
  expect(rec.summary.succeeded).toBe(true);
});

test('selectSink defaults to local, honors env', () => {
  expect(selectSink({})).toBe('local');
  expect(selectSink({ RALPH_OUTCOME_SINK: 'supabase' })).toBe('supabase');
  expect(selectSink({ RALPH_OUTCOME_SINK: 'LOCAL' })).toBe('local');
});

test('recordTaskOutcome writes a JSONL line to .ralph/outcomes.jsonl (local sink)', () => {
  const rootDir = tmpRoot();
  const r = recordTaskOutcome({ rootDir, story: story(), ledgerEntries: [] });
  expect(r.ok).toBe(true);
  expect(r.sink).toBe('local');
  const raw = fs.readFileSync(path.join(rootDir, '.ralph', 'outcomes.jsonl'), 'utf8').trim();
  const parsed = JSON.parse(raw);
  expect(parsed.task.story_id).toBe('STORY-X');
  expect(parsed.summary.succeeded).toBe(true);
});

test('recordTaskOutcome supabase sink uses injected writer', () => {
  const rootDir = tmpRoot();
  let captured = null;
  const r = recordTaskOutcome({
    rootDir,
    story: story(),
    env: { RALPH_OUTCOME_SINK: 'supabase' },
    writeSupabase: (rec) => { captured = rec; }
  });
  expect(r.ok).toBe(true);
  expect(r.sink).toBe('supabase');
  expect(captured.task.story_id).toBe('STORY-X');
});

test('recordTaskOutcome supabase sink falls back to local (never drops data) when writer throws', () => {
  const rootDir = tmpRoot();
  const r = recordTaskOutcome({
    rootDir,
    story: story(),
    env: { RALPH_OUTCOME_SINK: 'supabase' },
    writeSupabase: () => { throw new Error('db down'); }
  });
  expect(r.ok).toBe(true);
  expect(r.sink).toBe('local_fallback');
  expect(r.supabase_error).toBe('db down');
  expect(fs.existsSync(path.join(rootDir, '.ralph', 'outcomes.jsonl'))).toBe(true);
});

test('recordTaskOutcome supabase sink falls back to local when no writer provided', () => {
  const rootDir = tmpRoot();
  const r = recordTaskOutcome({
    rootDir,
    story: story(),
    env: { RALPH_OUTCOME_SINK: 'supabase' }
  });
  expect(r.sink).toBe('local_fallback');
  expect(r.reason).toBe('supabase_writer_not_provided');
});

test('recordTaskOutcome rejects missing story/rootDir', () => {
  expect(recordTaskOutcome({ rootDir: null, story: story() }).ok).toBe(false);
  expect(recordTaskOutcome({ rootDir: '/tmp', story: null }).ok).toBe(false);
  expect(recordTaskOutcome({ rootDir: '/tmp', story: {} }).ok).toBe(false);
});

test('failed story records failure_class from blocked_reason', () => {
  const rootDir = tmpRoot();
  const s = story({ status: 'failed', current_phase: 'ESCALATED', blocked_reason: 'requested_paths_coverage_incomplete', attempts: 3 });
  const r = recordTaskOutcome({ rootDir, story: s, ledgerEntries: [{ model: s.executor_model, cost_usd: 0.1, story_id: s.story_id }] });
  const exec = r.record.executions.find((e) => e.role === 'executor');
  expect(exec.succeeded).toBe(false);
  expect(exec.failure_class).toBe('requested_paths_coverage_incomplete');
  expect(r.record.task.actual_difficulty).toBe('hard');
});
