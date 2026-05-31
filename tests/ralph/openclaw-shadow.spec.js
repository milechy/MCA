const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeBackendResult,
  compareBackends,
  runShadowComparison,
  recordShadowComparison,
  summarizeShadowLog
} = require('../../src/ralph/openclaw-shadow');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-shadow-'));
}

// A clock that advances a fixed step on each call, so durations are deterministic.
function steppedClock(step = 10) {
  let t = 0;
  return () => (t += step);
}

test('normalizeBackendResult pulls a comparable shape from either dispatcher', () => {
  const oc = normalizeBackendResult({ ok: true, candidate_patch_path: 'p', execution_connected: true }, { duration_ms: 50 });
  expect(oc).toMatchObject({ ok: true, candidate_patch_path: 'p', duration_ms: 50, cost_usd: null });
  const kimi = normalizeBackendResult({ ok: true, executor_model: 'kimi', cost_usd: 0.04 }, { duration_ms: 80 });
  expect(kimi).toMatchObject({ ok: true, model: 'kimi', cost_usd: 0.04, duration_ms: 80 });
});

test('compareBackends classifies agreement, faster, cheaper', () => {
  const a = compareBackends(
    { ok: true, duration_ms: 30, cost_usd: 0 },
    { ok: true, duration_ms: 80, cost_usd: 0.05 }
  );
  expect(a).toMatchObject({ agreement: 'both_valid', faster: 'openclaw', cheaper: 'openclaw', both_produced_valid_patch: true });

  expect(compareBackends({ ok: true }, { ok: false }).agreement).toBe('only_openclaw');
  expect(compareBackends({ ok: false }, { ok: true }).agreement).toBe('only_kimi');
  expect(compareBackends({ ok: false }, { ok: false }).agreement).toBe('neither');
});

test('runShadowComparison runs both backends and builds a comparison', () => {
  const result = runShadowComparison({
    task: 'Add a file',
    requested_paths: ['x.js'],
    runOpenClaw: () => ({ ok: true, candidate_patch_path: '.ralph/tmp/oc/candidate.patch', execution_connected: true }),
    runOpenCodeKimi: () => ({ ok: true, candidate_patch_path: '.ralph/tmp/k/candidate.patch', executor_model: 'kimi', cost_usd: 0.04 }),
    clock: steppedClock(10)
  });
  expect(result.ok).toBe(true);
  expect(result.openclaw.ok).toBe(true);
  expect(result.opencode_kimi.ok).toBe(true);
  expect(result.comparison.both_produced_valid_patch).toBe(true);
  expect(result.openclaw.duration_ms).toBeGreaterThan(0);
});

test('runShadowComparison records only_kimi when OpenClaw fails', () => {
  const result = runShadowComparison({
    task: 'Add a file',
    runOpenClaw: () => ({ ok: false, reason: 'nemoclaw_runtime_timeout' }),
    runOpenCodeKimi: () => ({ ok: true, candidate_patch_path: 'p' }),
    clock: steppedClock()
  });
  expect(result.comparison.agreement).toBe('only_kimi');
  expect(result.openclaw.reason).toBe('nemoclaw_runtime_timeout');
});

test('runShadowComparison never throws if a backend throws (records as failure)', () => {
  const result = runShadowComparison({
    task: 'x',
    runOpenClaw: () => { throw new Error('sandbox unreachable'); },
    runOpenCodeKimi: () => ({ ok: true, candidate_patch_path: 'p' }),
    clock: steppedClock()
  });
  expect(result.ok).toBe(true);
  expect(result.openclaw.ok).toBe(false);
  expect(result.comparison.agreement).toBe('only_kimi');
});

test('runShadowComparison validates inputs', () => {
  expect(runShadowComparison({ runOpenClaw: () => {}, runOpenCodeKimi: () => {} }).reason).toBe('task_required');
  expect(runShadowComparison({ task: 't' }).reason).toBe('runners_required');
});

test('recordShadowComparison appends a JSONL line', () => {
  const rootDir = tmpRoot();
  const record = runShadowComparison({
    task: 't',
    runOpenClaw: () => ({ ok: true, candidate_patch_path: 'p' }),
    runOpenCodeKimi: () => ({ ok: true, candidate_patch_path: 'q' }),
    clock: steppedClock()
  });
  const w = recordShadowComparison({ rootDir, record, now: new Date('2026-05-31T00:00:00Z') });
  expect(w.ok).toBe(true);
  const lines = fs.readFileSync(path.join(rootDir, '.ralph', 'shadow-execution.jsonl'), 'utf8').trim().split('\n');
  expect(lines.length).toBe(1);
  expect(JSON.parse(lines[0]).comparison.both_produced_valid_patch).toBe(true);
});

test('summarizeShadowLog reports a migration verdict', () => {
  expect(summarizeShadowLog([]).verdict).toBe('no_data');

  const valid = { openclaw: { ok: true }, opencode_kimi: { ok: true }, comparison: { both_produced_valid_patch: true, faster: 'openclaw' } };
  const small = summarizeShadowLog([valid, valid, valid]);
  expect(small.verdict).toBe('insufficient_samples');

  const big = summarizeShadowLog(Array.from({ length: 6 }, () => valid));
  expect(big.verdict).toBe('openclaw_competitive');
  expect(big.openclaw_valid_rate).toBe(1);

  const behind = summarizeShadowLog([
    ...Array.from({ length: 5 }, () => ({ openclaw: { ok: false }, opencode_kimi: { ok: true }, comparison: {} }))
  ]);
  expect(behind.verdict).toBe('openclaw_behind');
});
