const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const EMPTY_DIFF_HASH = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const RALPH_RUNTIME_DIFF_EXCLUDES = Object.freeze([':(exclude).ralph/**']);

const VOLATILE_PLAN_FIELDS = new Set([
  'created_at',
  'updated_at',
  'expires_at',
  'approved_at',
  'generated_by',
  'model_response_id',
  'trace_id',
  'token_usage',
  'latency_ms'
]);

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .filter((key) => !VOLATILE_PLAN_FIELDS.has(key))
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }

  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function calculatePlanHash(plan) {
  return sha256(canonicalJson(plan));
}

function calculateDiffHash(cwd = process.cwd()) {
  // Phase 7 #2: silence stderr. When cwd is a non-git directory (common in
  // test tmpdirs created via fs.mkdtempSync without `git init`), git emits
  // `error: Could not access './**'` to stderr while exiting non-zero. The
  // outer caller (approval-manager::safePreExecDiffHash) catches the throw
  // and returns a sentinel hash — so the throw itself is harmless — but the
  // raw stderr leaks into the parent process stderr, polluting:
  //   (1) `npm run test:ralph` output during ralph-test gates,
  //   (2) daemon failure summaries (Phase 5 #2 retry-on-flake matched on
  //       this exact substring, wasting retry cycles),
  //   (3) operator-facing audit logs.
  // Phase 6 #5 smoke v2 + Phase 7 #1 instrumentation traced the issue to
  // this exact line; Phase 5 #2 traced 333 git invocations across a full
  // ralph-test run and could not find a `./**` argv match because the arg
  // IS the magic-pathspec `:(exclude).ralph/**` — git's pathspec parser
  // shortens it to `./**` in the error message when no repo is found.
  // The fix is just to discard stderr; the throw still propagates so the
  // safePreExecDiffHash try/catch still triggers the sentinel-hash fallback
  // for non-repo cwds.
  const diff = execFileSync('git', ['diff', '--binary', '--full-index', '--', '.', ...RALPH_RUNTIME_DIFF_EXCLUDES], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  return sha256(diff);
}

module.exports = {
  EMPTY_DIFF_HASH,
  RALPH_RUNTIME_DIFF_EXCLUDES,
  VOLATILE_PLAN_FIELDS,
  sha256,
  canonicalize,
  canonicalJson,
  calculatePlanHash,
  calculateDiffHash
};
