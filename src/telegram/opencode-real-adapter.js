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

function normalizeMessage(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

function buildCandidatePatchPrompt(taskText) {
  return normalizeMessage([
    'Run in sandbox only.',
    'Do not apply changes to the repository working tree.',
    `Create a file named ${DEFAULT_CANDIDATE_PATCH} in the current directory.`,
    'The file must contain a unified git diff only, suitable for later review and apply.',
    'Do not run deploys, migrations, git commit, git push, or open pull requests.',
    `Task: ${taskText}`
  ].join(' '));
}

function buildOpenCodeRunInvocation({ task, env = process.env } = {}) {
  const cli = normalizeCli(env[OPENCODE_CLI_ENV]);
  if (!cli) {
    return { ok: false, reason: 'opencode_cli_not_allowed', command: null, args: [] };
  }
  const taskText = normalizeMessage(task);
  if (!taskText) {
    return { ok: false, reason: 'task_required', command: null, args: [] };
  }
  return {
    ok: true,
    reason: null,
    command: cli,
    args: ['run', buildCandidatePatchPrompt(taskText)],
    candidate_patch_filename: DEFAULT_CANDIDATE_PATCH,
    repo_mutation_allowed: false,
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    deploy_allowed: false,
    migration_allowed: false
  };
}

module.exports = { OPENCODE_CLI_ENV, DEFAULT_OPENCODE_CLI, DEFAULT_CANDIDATE_PATCH, normalizeCli, normalizeMessage, buildCandidatePatchPrompt, buildOpenCodeRunInvocation };
