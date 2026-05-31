#!/usr/bin/env node
// Phase C data gathering — run a small set of DIVERSE coding tasks through the
// shadow harness (OpenClaw + opencode-kimi), record each comparison, and print
// the aggregate migration verdict. Neither backend's output is applied.
//
// Cost: the opencode-kimi side makes a real OpenRouter call per task
// (~$0.05). OpenClaw uses the sandbox's gemini. Run when you want a Phase C
// data point across difficulty tiers, not on every commit.
const path = require('node:path');
const fs = require('node:fs');
const { runShadowComparison, recordShadowComparison, summarizeShadowLog } = require('../../src/ralph/openclaw-shadow');
const { runOpenClaw, runOpenCodeKimi } = require('./openclaw-shadow-smoke');

const ROOT = path.resolve(__dirname, '..', '..');

// Diverse, independent tasks spanning trivial → hard. Each targets a distinct
// path so patches never collide, and is candidate-patch-only (no apply/commit).
const TASKS = [
  { id: 'docs', path: 'docs/shadow-note.md', desc: 'a one-paragraph markdown note titled "Shadow Note"' },
  { id: 'clamp', path: 'src/ralph/utils/clamp.js', desc: 'a clamp(n, min, max) utility (CommonJS module.exports) plus its Playwright test at tests/ralph/utils/clamp.spec.js', paths: ['src/ralph/utils/clamp.js', 'tests/ralph/utils/clamp.spec.js'] },
  { id: 'debounce', path: 'src/ralph/utils/debounce.js', desc: 'a debounce(fn, ms) utility (CommonJS) plus a Playwright test', paths: ['src/ralph/utils/debounce.js', 'tests/ralph/utils/debounce.spec.js'] },
  { id: 'lru', path: 'src/ralph/utils/lru-cache.js', desc: 'a fixed-capacity LRUCache class with get/set eviction (CommonJS) plus a Playwright test', paths: ['src/ralph/utils/lru-cache.js', 'tests/ralph/utils/lru-cache.spec.js'] },
  { id: 'toposort', path: 'src/ralph/utils/toposort.js', desc: 'a topologicalSort(graph) function detecting cycles (CommonJS) plus a Playwright test', paths: ['src/ralph/utils/toposort.js', 'tests/ralph/utils/toposort.spec.js'] },
  { id: 'token-bucket', path: 'src/ralph/utils/token-bucket.js', desc: 'a TokenBucket rate limiter (capacity, refillPerSec, tryRemove) class (CommonJS) plus a Playwright test', paths: ['src/ralph/utils/token-bucket.js', 'tests/ralph/utils/token-bucket.spec.js'] }
];

function taskText(t) {
  const paths = t.paths || [t.path];
  return `Create a minimal candidate patch that adds ${t.desc}. The unified diff must touch only: ${paths.join(', ')}. Do not apply, commit, push, create pull requests, deploy, migrate, or modify the working tree.`;
}

function readShadowLog() {
  const p = path.join(ROOT, '.ralph', 'shadow-execution.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function main() {
  const results = [];
  for (const t of TASKS) {
    const requested_paths = t.paths || [t.path];
    process.stderr.write(`\n[shadow-batch] ${t.id} (${requested_paths.length} path(s))...\n`);
    const record = runShadowComparison({
      rootDir: ROOT,
      task: taskText(t),
      requested_paths,
      story_id: `SHADOW-${t.id.toUpperCase()}`,
      env: process.env,
      runOpenClaw,
      runOpenCodeKimi
    });
    if (record.ok) recordShadowComparison({ rootDir: ROOT, record });
    const c = record.comparison || {};
    process.stderr.write(`  openclaw=${record.openclaw?.ok}(${record.openclaw?.duration_ms}ms) kimi=${record.opencode_kimi?.ok}(${record.opencode_kimi?.duration_ms}ms) -> ${c.agreement}, faster=${c.faster}\n`);
    results.push({ id: t.id, agreement: c.agreement, faster: c.faster, openclaw_ok: record.openclaw?.ok, kimi_ok: record.opencode_kimi?.ok });
  }

  const summary = summarizeShadowLog(readShadowLog());
  process.stdout.write(JSON.stringify({ batch: results, summary }, null, 2) + '\n');
}

if (require.main === module) main();
