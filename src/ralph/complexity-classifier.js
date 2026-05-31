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

// Fast path: hit a persistent classifier server (the model is already loaded,
// ~110ms) via curl so the call stays synchronous. Returns the signal or null.
function classifyViaServer({ prompt, url, timeoutMs, spawnImpl }) {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const res = spawnImpl('curl', [
    '-s', '--max-time', String(seconds),
    '-X', 'POST', '-H', 'Content-Type: application/json',
    '--data-binary', JSON.stringify({ prompt }), url
  ], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  if (!res || res.status !== 0 || !res.stdout) return null;
  try {
    const sig = JSON.parse(res.stdout.trim().split('\n').filter(Boolean).pop());
    return sig && sig.ok ? sig : null;
  } catch {
    return null;
  }
}

function classifyPrompt({
  prompt,
  env = process.env,
  backend = env.NEMOCLAW_CLASSIFIER_BACKEND || 'nvidia',
  python = env.NEMOCLAW_CLASSIFIER_PYTHON || DEFAULT_PYTHON,
  serverUrl = env.NEMOCLAW_CLASSIFIER_URL || null,
  timeoutMs = Number(env.NEMOCLAW_CLASSIFIER_TIMEOUT_MS) || 30000,
  spawnImpl = spawnSync
} = {}) {
  if (!prompt || typeof prompt !== 'string') return null;
  if ((env.NEMOCLAW_CLASSIFIER || 'on') === 'off') return null;

  // Prefer the persistent server (no per-call model load) when configured;
  // fall back to the one-shot subprocess if it's unreachable.
  if (serverUrl) {
    const viaServer = classifyViaServer({ prompt, url: serverUrl, timeoutMs, spawnImpl });
    if (viaServer) return viaServer;
  }

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

module.exports = { classifyPrompt, classifyViaServer, CLASSIFIER_DIR, SCRIPT, DEFAULT_PYTHON };
