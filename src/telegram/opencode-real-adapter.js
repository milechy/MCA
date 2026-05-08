const path = require('node:path');

const OPENCODE_CLI_ENV = 'RALPH_OPENCODE_CLI';
const DEFAULT_OPENCODE_CLI = 'opencode';
const DEFAULT_CANDIDATE_PATCH = 'candidate.patch';

function normalizeCli(value) {
  const cli = String(value || '').trim();
  if (!cli) return DEFAULT_OPENCODE_CLI;
  if (/[;&|`$<>]/.test(cli) || cli.includes('..')) return null;
  if (path.isAbsolute(cli)) return null;
  return cli;
}

function buildOpenCodeRunInvocation({ task, env = process.env } = {}) {
  const cli = normalizeCli(env[OPENCODE_CLI_ENV]);
  if (!cli) {
    return { ok: false, reason: 'opencode_cli_not_allowed', command: null, args: [] };
  }
  const taskText = String(task || '').trim();
  if (!taskText) {
    return { ok: false, reason: 'task_required', command: null, args: [] };
  }
  return {
    ok: true,
    reason: null,
    command: cli,
    args: ['run', '--diff-only', '--output', DEFAULT_CANDIDATE_PATCH, '--task', taskText],
    candidate_patch_filename: DEFAULT_CANDIDATE_PATCH,
    repo_mutation_allowed: false,
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    deploy_allowed: false,
    migration_allowed: false
  };
}

module.exports = { OPENCODE_CLI_ENV, DEFAULT_OPENCODE_CLI, DEFAULT_CANDIDATE_PATCH, normalizeCli, buildOpenCodeRunInvocation };
