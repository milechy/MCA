const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Phase A — Node bridge to the NVIDIA prompt-task-and-complexity classifier.
//
// The classifier itself is Python (transformers + the NVIDIA DeBERTa model);
// this thin wrapper shells out to scripts/ralph/complexity-classifier/classify.py
// and returns the parsed signal, or null on any failure so the brain falls back
// to the static ladder instead of blocking the loop. The Python side already
// degrades nvidia→heuristic internally, so a returned signal is always usable.
//
// Kept dependency-light and fully injectable (spawnImpl) for tests.

const CLASSIFIER_DIR = path.join(__dirname, '..', '..', 'scripts', 'ralph', 'complexity-classifier');
const DEFAULT_PYTHON = path.join(CLASSIFIER_DIR, '.venv', 'bin', 'python');
const SCRIPT = path.join(CLASSIFIER_DIR, 'classify.py');

function classifyPrompt({
  prompt,
  env = process.env,
  backend = env.NEMOCLAW_CLASSIFIER_BACKEND || 'nvidia',
  python = env.NEMOCLAW_CLASSIFIER_PYTHON || DEFAULT_PYTHON,
  timeoutMs = Number(env.NEMOCLAW_CLASSIFIER_TIMEOUT_MS) || 30000,
  spawnImpl = spawnSync
} = {}) {
  if (!prompt || typeof prompt !== 'string') return null;
  if ((env.NEMOCLAW_CLASSIFIER || 'on') === 'off') return null;
  try {
    const res = spawnImpl(python, [SCRIPT, '--backend', backend], {
      input: JSON.stringify({ prompt }),
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024
    });
    if (!res || res.status !== 0 || !res.stdout) return null;
    // The script prints exactly one JSON object on stdout (last non-empty line
    // is the result even if warnings leaked to stdout).
    const line = res.stdout.trim().split('\n').filter(Boolean).pop();
    const sig = JSON.parse(line);
    return sig && sig.ok ? sig : null;
  } catch {
    return null;
  }
}

module.exports = { classifyPrompt, CLASSIFIER_DIR, SCRIPT, DEFAULT_PYTHON };
