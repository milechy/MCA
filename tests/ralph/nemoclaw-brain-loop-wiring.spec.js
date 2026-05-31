const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStory, readStory } = require('../../src/ralph/story-queue');
const { tickAutonomousLoop, LOOP_PHASES } = require('../../src/ralph/autonomous-loop');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-brain-wiring-'));
}

function readOutcomes(rootDir) {
  const p = path.join(rootDir, '.ralph', 'outcomes.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Seed a story poised at the final approval gate so a single approved tick
// drives it to DONE through tickAutonomousLoop (the wrapper that owns the
// A7 terminal-outcome hook).
function seedAtPrApproval(rootDir) {
  const created = createStory({
    story_id: 'STORY-A7',
    title: 'A7 terminal recording',
    requirement: 'Implement a feature with tests.',
    status: 'running',
    current_phase: LOOP_PHASES.PR_APPROVAL_PENDING,
    current_approval_id: 'APR-PR',
    executor_model: 'openrouter/anthropic/claude-haiku-4.5',
    difficulty: 'medium',
    context_bucket: 'medium|create|js|2-3f',
    routing_source: 'nemoclaw_classifier_tier'
  }, { rootDir, now: new Date('2026-05-31T00:00:00.000Z') });
  expect(created.ok).toBe(true);
  return created.story.story_id;
}

test('A7: reaching DONE through tickAutonomousLoop records an outcome (closes the data end)', () => {
  const rootDir = tmpRoot();
  seedAtPrApproval(rootDir);
  expect(readOutcomes(rootDir).length).toBe(0);

  const result = tickAutonomousLoop({
    rootDir,
    story_id: 'STORY-A7',
    now: new Date('2026-05-31T00:01:00.000Z'),
    approvals: { 'APR-PR': 'approved' }
  });

  expect(result.to_phase).toBe(LOOP_PHASES.DONE);
  const outcomes = readOutcomes(rootDir);
  expect(outcomes.length).toBe(1);
  expect(outcomes[0].task.story_id).toBe('STORY-A7');
  expect(outcomes[0].summary.succeeded).toBe(true);
  // the executor model the brain picked is carried into the learning record
  expect(outcomes[0].executions[0].model).toBe('openrouter/anthropic/claude-haiku-4.5');
});

test('A7: an already-terminal story is NOT re-recorded on subsequent ticks', () => {
  const rootDir = tmpRoot();
  seedAtPrApproval(rootDir);
  tickAutonomousLoop({ rootDir, story_id: 'STORY-A7', approvals: { 'APR-PR': 'approved' } });
  expect(readOutcomes(rootDir).length).toBe(1);

  // tick again — story is now DONE; the entry short-circuit must not re-record.
  tickAutonomousLoop({ rootDir, story_id: 'STORY-A7', approvals: { 'APR-PR': 'approved' } });
  expect(readOutcomes(rootDir).length).toBe(1);
});

test('A7: a non-terminal tick records nothing', () => {
  const rootDir = tmpRoot();
  createStory({
    story_id: 'STORY-WAIT', title: 'waiting', requirement: 'x',
    status: 'running', current_phase: LOOP_PHASES.PR_APPROVAL_PENDING, current_approval_id: 'APR-PR'
  }, { rootDir });
  // No approval provided → stays WAITING, no terminal transition.
  const result = tickAutonomousLoop({ rootDir, story_id: 'STORY-WAIT', approvals: {} });
  expect(result.to_phase).toBe(LOOP_PHASES.PR_APPROVAL_PENDING);
  expect(readOutcomes(rootDir).length).toBe(0);
});
