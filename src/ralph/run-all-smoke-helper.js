const { runApprovedShellCommand } = require('./shell-approved-executor');

const EMPTY_DIFF_HASH = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function runAllApprovedSmoke(approvalId, plan, options = {}) {
  return runApprovedShellCommand(
    approvalId,
    plan,
    { command: 'scripts/gates/run-all.sh', args: [], cwd: '.' },
    {
      rootDir: options.rootDir || process.cwd(),
      current_diff_hash: options.current_diff_hash || EMPTY_DIFF_HASH,
      allow_real_execution: true,
      timeout_ms: options.timeout_ms || 180_000,
      allowlist: [
        {
          id: 'gates-run-all-smoke-test-only',
          command: 'scripts/gates/run-all.sh',
          allowed_args: [],
          allowed_cwd: '.',
          phase: '3.8b-smoke-test-only',
          dry_run_only: false
        }
      ]
    }
  );
}

module.exports = {
  EMPTY_DIFF_HASH,
  runAllApprovedSmoke
};
