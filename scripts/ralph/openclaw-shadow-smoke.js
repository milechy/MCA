#!/usr/bin/env node
// Phase B2 — run ONE real shadow comparison: the same coding task through the
// OpenClaw (NemoClaw/OpenShell) backend AND the production opencode-kimi
// dispatcher, then record + print the comparison. Neither result is applied,
// committed, or merged — this only gathers data for the Phase C migration call.
//
// Env:
//   NEMOCLAW_SANDBOX_NAME   OpenClaw sandbox (default mca-ralph)
//   OPENROUTER_API_KEY      needed for the opencode-kimi side (else it fails →
//                           comparison shows only_openclaw, which is still useful)
//   RALPH_SHADOW_TASK       override the task text
//   RALPH_SHADOW_PATHS      comma-separated requested paths
//   RALPH_SHADOW_TIMEOUT_MS per-backend timeout (default 120000)
const path = require('node:path');
const { runNemoClawOpenCodeCandidatePatch } = require('../../src/ralph/nemoclaw-opencode-gateway');
const { dispatchOpenCodeKimi } = require('../../src/ralph/opencode-kimi-dispatcher');
const { runShadowComparison, recordShadowComparison } = require('../../src/ralph/openclaw-shadow');

const ROOT = path.resolve(__dirname, '..', '..');
const TIMEOUT_MS = Number(process.env.RALPH_SHADOW_TIMEOUT_MS) || 120000;
const DEFAULT_PATH = 'tests/openclaw-shadow-generated.spec.js';
const DEFAULT_TASK = process.env.RALPH_SHADOW_TASK
  || `Create a minimal candidate patch that adds only ${DEFAULT_PATH} containing a single trivial passing test using @playwright/test. The unified diff must touch exactly that one file. Do not apply, commit, push, create PRs, deploy, migrate, or modify the working tree.`;
const REQUESTED_PATHS = (process.env.RALPH_SHADOW_PATHS || DEFAULT_PATH).split(',').map((p) => p.trim()).filter(Boolean);

function runOpenClaw({ rootDir, task, requested_paths, env }) {
  return runNemoClawOpenCodeCandidatePatch({
    rootDir,
    sandbox_root: '.ralph/tmp/shadow-openclaw',
    requested_paths,
    task,
    env: { ...env, NEMOCLAW_SANDBOX_NAME: env.NEMOCLAW_SANDBOX_NAME || 'mca-ralph' },
    timeout_ms: TIMEOUT_MS
  });
}

function runOpenCodeKimi({ rootDir, task, requested_paths, env }) {
  return dispatchOpenCodeKimi({
    rootDir,
    story: { story_id: 'SHADOW-SMOKE', difficulty: 'easy', requested_paths },
    sandbox_root: '.ralph/tmp/shadow-kimi',
    task,
    requested_paths,
    env,
    timeout_ms: TIMEOUT_MS
  });
}

function main() {
  const result = runShadowComparison({
    rootDir: ROOT,
    task: DEFAULT_TASK,
    requested_paths: REQUESTED_PATHS,
    story_id: 'SHADOW-SMOKE',
    env: process.env,
    runOpenClaw,
    runOpenCodeKimi
  });
  if (result.ok) recordShadowComparison({ rootDir: ROOT, record: result });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  // Exit 0 as long as the harness ran; the comparison itself is the signal.
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { runOpenClaw, runOpenCodeKimi };
